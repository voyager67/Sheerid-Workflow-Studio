import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { OAuthTokenManager, requiredEnv, SheerFlowError } from './auth.js';
import { SheerIDClient } from './client.js';
import { JobManager } from './jobs.js';
import { MockSheerIDClient } from './mock-client.js';
import { DEFAULT_MAX_DOCUMENT_BYTES } from './documents.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/brand.png', ['assets/brand/sheerflow-banner.png', 'image/png']],
]);

function readConfig(env) {
  const mode = env.SHEERFLOW_MODE || 'live';
  if (!['live', 'demo'].includes(mode)) throw new SheerFlowError('INVALID_MODE', 'SHEERFLOW_MODE must be live or demo.');
  const port = Number(env.SHEERFLOW_PORT || 8787);
  const concurrency = Number(env.SHEERFLOW_CONCURRENCY || 2);
  const pollIntervalMs = Number(env.SHEERFLOW_POLL_INTERVAL_MS || 5000);
  const maxDocumentBytes = Number(env.SHEERFLOW_MAX_DOCUMENT_BYTES || DEFAULT_MAX_DOCUMENT_BYTES);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SheerFlowError('INVALID_PORT', 'SHEERFLOW_PORT must be between 1024 and 65535.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new SheerFlowError('INVALID_CONCURRENCY', 'SHEERFLOW_CONCURRENCY must be between 1 and 8.');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 3000 || pollIntervalMs > 300000) throw new SheerFlowError('INVALID_POLL_INTERVAL', 'SHEERFLOW_POLL_INTERVAL_MS must be between 3000 and 300000.');
  if (!Number.isInteger(maxDocumentBytes) || maxDocumentBytes < 1024 || maxDocumentBytes > 20 * 1024 * 1024) throw new SheerFlowError('INVALID_DOCUMENT_LIMIT', 'SHEERFLOW_MAX_DOCUMENT_BYTES must be between 1 KB and 20 MiB.');
  const host = env.SHEERFLOW_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new SheerFlowError('REMOTE_BIND_DISABLED', 'SheerFlow binds to loopback only. Put it behind your own authenticated HTTPS gateway only after a separate security review.');
  const password = requiredEnv(env, 'SHEERFLOW_DASHBOARD_PASSWORD');
  if (password.length < 20) throw new SheerFlowError('WEAK_DASHBOARD_PASSWORD', 'SHEERFLOW_DASHBOARD_PASSWORD must contain at least 20 characters.');
  let programId = null;
  let programLabel = env.SHEERFLOW_PROGRAM_LABEL || 'Configured program';
  if (mode === 'live') {
    programId = requiredEnv(env, 'SHEERID_PROGRAM_ID');
    requiredEnv(env, 'SHEERID_CLIENT_ID');
    requiredEnv(env, 'SHEERID_CLIENT_SECRET');
    if (!/^[a-f\d]{24}$/i.test(programId)) throw new SheerFlowError('INVALID_PROGRAM_ID', 'SHEERID_PROGRAM_ID must be a 24-character hexadecimal program ID.');
  } else {
    programLabel = 'Local demo — no external API calls';
    programId = '000000000000000000000000';
  }
  return { mode, port, host, concurrency, pollIntervalMs, maxDocumentBytes, password, programId, programLabel };
}

function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

async function readBody(request, limit) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > limit) throw new SheerFlowError('BODY_TOO_LARGE', 'Request exceeds the configured size limit.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new SheerFlowError('BODY_TOO_LARGE', 'Request exceeds the configured size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new SheerFlowError('JSON_INVALID', `${label} must be valid JSON.`); }
}

async function readJsonBody(request, limit, label) {
  const raw = await readBody(request, limit);
  try {
    const value = parseJson(raw.toString('utf8'), label);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SheerFlowError('JSON_INVALID', `${label} must be a JSON object.`);
    return value;
  } finally {
    raw.fill(0);
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

function sessionCookie(sessionId) {
  return `sheerflow_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`;
}

export function createSheerFlowServer({ env = process.env, client: injectedClient, manager: injectedManager, port: portOverride } = {}) {
  const config = readConfig(env);
  if (portOverride !== undefined) config.port = portOverride;
  const tokenManager = config.mode === 'live' ? new OAuthTokenManager({
    clientId: requiredEnv(env, 'SHEERID_CLIENT_ID'),
    clientSecret: requiredEnv(env, 'SHEERID_CLIENT_SECRET'),
  }) : null;
  const client = injectedClient || (config.mode === 'demo' ? new MockSheerIDClient() : new SheerIDClient({ tokenManager }));
  const jobs = injectedManager || new JobManager({ client, programId: config.programId, concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs, maxDocumentBytes: config.maxDocumentBytes });
  const sessions = new Map();
  const loginFailures = new Map();
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const status = error.code === 'JOB_NOT_FOUND' ? 404
        : ['QUEUE_FULL', 'JOB_NOT_READY_FOR_DOCUMENT', 'JOB_NOT_CLEARABLE', 'IDEMPOTENCY_CONFLICT'].includes(error.code) ? 409
          : error.code === 'UNAUTHORIZED' ? 401
            : error.code === 'LOGIN_RATE_LIMIT' || error.status === 429 ? 429
              : ['ORIGIN_REJECTED', 'HOST_REJECTED', 'CSRF_REJECTED'].includes(error.code) ? 403
              : ['BODY_TOO_LARGE', 'DOCUMENT_SIZE_INVALID'].includes(error.code) ? 413
              : error instanceof SheerFlowError ? 400 : 500;
      sendJson(response, status, { error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Request failed.' } });
    });
  });
  server.requestTimeout = 120_000;

  function authorizeHost(request) {
    const address = server.address();
    const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`];
    if (!hosts.includes(request.headers.host)) throw new SheerFlowError('HOST_REJECTED', 'Only the local dashboard host is accepted.');
    if (request.headers.origin) {
      const expected = `http://${request.headers.host}`;
      if (request.headers.origin !== expected) throw new SheerFlowError('ORIGIN_REJECTED', 'Cross-origin requests are not allowed.');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new SheerFlowError('ORIGIN_REJECTED', 'Cross-site requests are not allowed.');
  }

  function authorizeSession(request, write = false) {
    const rawCookie = (request.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith('sheerflow_session='))?.slice('sheerflow_session='.length);
    const session = rawCookie && sessions.get(rawCookie);
    if (!session || session.expiresAt < Date.now()) {
      if (rawCookie) sessions.delete(rawCookie);
      throw new SheerFlowError('UNAUTHORIZED', 'Session expired. Sign in again.');
    }
    if (write && !safeEqual(request.headers['x-csrf-token'] || '', session.csrf)) {
      throw new SheerFlowError('CSRF_REJECTED', 'Missing or invalid request token. Refresh the page and try again.');
    }
    return session;
  }

  async function handle(request, response) {
    authorizeHost(request);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'GET' && assets.has(url.pathname)) {
      const [relative, contentType] = assets.get(url.pathname);
      const target = resolve(ROOT, relative);
      const bytes = await readFile(target);
      response.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length });
      response.end(bytes);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new SheerFlowError('CONTENT_TYPE_INVALID', 'Login requires JSON.');
      const ip = request.socket.remoteAddress || 'local';
      const now = Date.now();
      for (const [key, activeSessions] of sessions) if (activeSessions.expiresAt < now) sessions.delete(key);
      const failures = (loginFailures.get(ip) || []).filter(time => now - time < 60_000);
      if (failures.length >= 8) throw new SheerFlowError('LOGIN_RATE_LIMIT', 'Too many login attempts. Wait one minute.');
      const body = await readJsonBody(request, 4096, 'Login request');
      if (!safeEqual(body.password || '', config.password)) {
        failures.push(now); loginFailures.set(ip, failures);
        throw new SheerFlowError('UNAUTHORIZED', 'Incorrect dashboard password.');
      }
      loginFailures.delete(ip);
      const id = randomBytes(32).toString('hex');
      const csrf = randomBytes(32).toString('hex');
      sessions.set(id, { csrf, expiresAt: now + 8 * 60 * 60 * 1000 });
      response.setHeader('set-cookie', sessionCookie(id));
      sendJson(response, 200, { csrfToken: csrf });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const session = authorizeSession(request, true);
      const cookie = (request.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sheerflow_session='))?.slice('sheerflow_session='.length);
      if (cookie) sessions.delete(cookie);
      response.setHeader('set-cookie', 'sheerflow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      sendJson(response, 200, { ok: true });
      return;
    }
    const session = authorizeSession(request, request.method !== 'GET');
    if (request.method === 'GET' && url.pathname === '/api/config') {
      sendJson(response, 200, { mode: config.mode, programLabel: config.programLabel,
        programId: config.mode === 'live' ? `${config.programId.slice(0, 4)}…${config.programId.slice(-4)}` : 'DEMO',
        concurrency: config.concurrency, pollIntervalMs: config.pollIntervalMs,
        maxDocumentBytes: config.maxDocumentBytes, csrfToken: session.csrf });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      sendJson(response, 200, { jobs: jobs.list() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/organizations') {
      const query = url.searchParams.get('q') || '';
      const organizations = await client.searchOrganizations(config.programId, query);
      sendJson(response, 200, { organizations });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new SheerFlowError('CONTENT_TYPE_INVALID', 'Job creation requires JSON.');
      const body = await readJsonBody(request, 64 * 1024, 'Job request');
      const job = jobs.create({ subjectData: body.subjectData, consent: body.consent,
        clientRequestId: body.clientRequestId, demoScenario: config.mode === 'demo' ? body.demoScenario : 'approved' });
      sendJson(response, 202, { job });
      return;
    }
    const match = url.pathname.match(/^\/api\/jobs\/([a-f\d-]{36})(?:\/(cancel|refresh|resubmit|documents?))?$/i);
    if (match && request.method === 'GET' && !match[2]) { sendJson(response, 200, { job: jobs.get(match[1]) }); return; }
    if (match && request.method === 'DELETE' && !match[2]) { sendJson(response, 200, jobs.delete(match[1])); return; }
    if (match && request.method === 'POST' && match[2] === 'cancel') { sendJson(response, 200, { job: jobs.cancel(match[1]) }); return; }
    if (match && request.method === 'POST' && match[2] === 'refresh') { sendJson(response, 200, { job: await jobs.refresh(match[1]) }); return; }
    if (match && request.method === 'POST' && match[2] === 'resubmit') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new SheerFlowError('CONTENT_TYPE_INVALID', 'Corrected subject data must be JSON.');
      const body = await readJsonBody(request, 64 * 1024, 'Resubmission request');
      sendJson(response, 200, { job: await jobs.resubmitSubject(match[1], { subjectData:body.subjectData, consent:body.consent }) });
      return;
    }
    if (match && request.method === 'POST' && ['document', 'documents'].includes(match[2])) {
      if (match[2] === 'document') {
        const mime = request.headers['content-type']?.split(';')[0];
        if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mime)) throw new SheerFlowError('DOCUMENT_TYPE_INVALID', 'Document content type must be PDF, PNG or JPEG.');
        const name = request.headers['x-document-name'];
        if (!name || name.length > 200) throw new SheerFlowError('DOCUMENT_NAME_INVALID', 'A safe document filename is required.');
        const bytes = await readBody(request, config.maxDocumentBytes);
        const job = await jobs.uploadDocument(match[1], bytes, name);
        sendJson(response, 200, { job });
        return;
      }
      const contentType = request.headers['content-type'] || '';
      if (!contentType.startsWith('multipart/form-data;')) throw new SheerFlowError('CONTENT_TYPE_INVALID', 'Upload documents using multipart/form-data.');
      const body = await readBody(request, config.maxDocumentBytes + 256 * 1024);
      const files = [];
      try {
        let form;
        try { form = await new Request(`http://127.0.0.1/api/upload`, { method:'POST', headers:{'content-type':contentType}, body, duplex:'half' }).formData(); }
        catch { throw new SheerFlowError('MULTIPART_INVALID', 'The document upload form is malformed.'); }
        body.fill(0);
        const values = form.getAll('documents');
        if (!values.length || values.length > 5 || values.some(file => typeof file.arrayBuffer !== 'function')) {
          throw new SheerFlowError('INVALID_DOCUMENT_COUNT', 'Select between 1 and 5 files.');
        }
        let totalBytes = 0;
        for (const file of values) {
          if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) throw new SheerFlowError('DOCUMENT_TYPE_INVALID', 'Only PDF, PNG and JPEG documents are accepted.');
          const bytes = Buffer.from(await file.arrayBuffer());
          totalBytes += bytes.length;
          files.push({ bytes, fileName:file.name });
          if (totalBytes > config.maxDocumentBytes) throw new SheerFlowError('DOCUMENT_BATCH_TOO_LARGE', 'Combined documents exceed the configured upload limit.');
        }
        form.delete('documents');
        const job = await jobs.uploadDocuments(match[1], files);
        sendJson(response, 200, { job });
        return;
      } finally {
        body.fill(0);
        for (const file of files) file.bytes.fill(0);
      }
    }
    throw new SheerFlowError('NOT_FOUND', 'Route not found.');
  }

  return {
    server, jobs, config,
    async start() {
      await new Promise((resolveStarted, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolveStarted(); };
        server.once('error', onError); server.once('listening', onListening);
        server.listen(config.port, config.host);
      });
      return `http://${config.host === '::1' ? '[::1]' : config.host}:${server.address().port}`;
    },
    async close() {
      jobs.close();
      sessions.clear();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolveClosed => server.close(resolveClosed));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createSheerFlowServer();
  const shutdown = () => { void app.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  app.start().then(address => process.stdout.write(`SheerFlow is running at ${address}\n`))
    .catch(error => { process.stderr.write(`Startup failed: ${error.message}\n`); process.exitCode = 1; });
}
