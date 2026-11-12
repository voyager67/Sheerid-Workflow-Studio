import { SheerFlowError } from './auth.js';
import { isIP } from 'node:net';

const OFFICIAL_BASE = 'https://services.sheerid.com/rest/v2/';
const ID_PATTERN = /^[a-f\d]{24}$/i;
const TERMINAL_LIMITS = new Set([
  'verificationLimitExceeded', 'reverificationDailyLimitExceeded', 'docReviewLimitExceeded',
  'incorrectVerificationOverrideCodeAttemptLimitExceeded', 'fraudRulesReject',
]);
const TRANSIENT_RATE_LIMIT = 'apiRateLimitExceeded';

function apiPath(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new SheerFlowError('INVALID_API_PATH', 'The requested API path is invalid.');
  }
  return path;
}

function assertProviderStepUrl(value, verificationId, allowedSteps, baseUrl = OFFICIAL_BASE) {
  let url;
  try { url = new URL(value); } catch { throw new SheerFlowError('INVALID_SUBMISSION_URL', 'SheerID returned an invalid submission URL.'); }
  const step = url.pathname.match(new RegExp(`^/rest/v2/verification/${verificationId}/step/([A-Za-z0-9]+)$`, 'i'))?.[1];
  const base = new URL(baseUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') || !step || !allowedSteps.includes(step) || url.username || url.password || url.hash || url.search) {
    throw new SheerFlowError('INVALID_SUBMISSION_URL', 'SheerID returned an unexpected submission URL. No data was sent.');
  }
  return url.href;
}

function assertStatusUrl(value, verificationId, baseUrl = OFFICIAL_BASE) {
  let url;
  try { url = new URL(value); } catch { throw new SheerFlowError('INVALID_STATUS_URL', 'SheerID returned an invalid status URL.'); }
  const base = new URL(baseUrl);
  if (url.origin !== base.origin
    || url.pathname !== `${base.pathname.replace(/\/$/, '')}/verification/${verificationId}`
    || url.username || url.password || url.hash || url.search) {
    throw new SheerFlowError('INVALID_STATUS_URL', 'SheerID returned an unexpected status URL.');
  }
  return `verification/${verificationId}`;
}

export function validateVerificationResponse(body, expectedVerificationId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.verificationId !== 'string' || !ID_PATTERN.test(body.verificationId)
    || typeof body.currentStep !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(body.currentStep)
    || (body.errorIds !== undefined && (!Array.isArray(body.errorIds)
      || body.errorIds.length > 50 || !body.errorIds.every(x => typeof x === 'string' && x.length <= 100)))) {
    throw new SheerFlowError('API_RESPONSE_INVALID', 'SheerID returned an invalid verification response.');
  }
  if (expectedVerificationId !== undefined && body.verificationId !== expectedVerificationId) {
    throw new SheerFlowError('VERIFICATION_ID_MISMATCH', 'SheerID returned a response for a different verification.');
  }
  return body;
}

export class SheerIDClient {
  constructor({ tokenManager, fetchImpl = fetch, baseUrl = OFFICIAL_BASE, timeoutMs = 15_000, retryBaseMs = 400, random = Math.random }) {
    this.tokens = tokenManager;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.timeoutMs = timeoutMs;
    this.retryBaseMs = retryBaseMs;
    this.random = random;
    this.themeCache = new Map();
  }

  async #request(method, path, body, { signedUpload = false, contentType = 'application/json', signal } = {}) {
    const url = new URL(apiPath(path), this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) throw new SheerFlowError('API_ORIGIN_REJECTED', 'The API request destination was rejected.');
    let forceRefresh = false;
    let authRefreshAttempted = false;
    let retries = 0;
    while (true) {
      const headers = { accept: 'application/json' };
      if (!signedUpload) headers.authorization = `Bearer ${await this.tokens.getToken({ forceRefresh })}`;
      if (body !== undefined && !signedUpload) headers['content-type'] = contentType;
      if (signedUpload) headers['content-type'] = contentType;
      let response;
      try {
        response = await this.fetch(url, {
          method, headers, body,
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new SheerFlowError(method === 'GET' ? 'API_NETWORK_ERROR' : 'API_WRITE_UNCERTAIN',
          method === 'GET' ? 'Could not read verification status from SheerID.' : 'The remote write may have reached SheerID, but its response was not received. Do not repeat the submission blindly.',
          { cause: error, uncertain: method !== 'GET' });
      }
      const data = response.status === 204 ? null : await safeJson(response);
      if (response.ok) return data;

      if (response.status === 401 && method === 'GET' && !authRefreshAttempted) {
        forceRefresh = true;
        authRefreshAttempted = true;
        continue;
      }

      const errorIds = Array.isArray(data?.errorIds) ? data.errorIds
        : typeof data?.errorId === 'string' ? [data.errorId] : [];
      const terminal = errorIds.some(id => TERMINAL_LIMITS.has(id));
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const transientApiLimit = response.status === 429 && errorIds.includes(TRANSIENT_RATE_LIMIT);
      const safeReadServerError = method === 'GET' && response.status >= 500 && retries < 3;
      const retryable = !terminal && retries < 3 && (transientApiLimit || safeReadServerError);
      if (retryable) {
        const exponentialDelay = Math.min(10_000, this.retryBaseMs * (2 ** retries));
        const jitter = Math.floor(this.random() * 250);
        const delay = retryAfterMs ?? exponentialDelay + jitter;
        retries += 1;
        await waitAbortably(delay, signal);
        continue;
      }
      const businessLimit = response.status === 429 && !transientApiLimit;
      const message = terminal || businessLimit
        ? `SheerID returned a non-retryable limit or business error${errorIds.length ? ` (${errorIds.join(', ')})` : ''}.`
        : `SheerID API request failed with HTTP ${response.status}.`;
      throw new SheerFlowError(terminal || businessLimit ? 'BUSINESS_LIMIT_REACHED' : 'SHEERID_API_ERROR', message, {
        status: response.status, retryAfterMs, details: { errorIds }, uncertain: method !== 'GET' && response.status >= 500,
      });
    }
  }

  async createVerification(programId, signal) {
    if (!/^[a-f\d]{24}$/i.test(programId)) throw new SheerFlowError('INVALID_PROGRAM_ID', 'Program ID must be a 24-character hexadecimal SheerID ID.');
    return validateVerificationResponse(await this.#request('POST', 'verification', JSON.stringify({ programId }), { signal }));
  }

  async submitSubject(verificationId, submissionUrl, subjectData, signal) {
    if (!ID_PATTERN.test(verificationId)) throw new SheerFlowError('INVALID_VERIFICATION_ID', 'Verification ID is invalid.');
    const url = assertProviderStepUrl(submissionUrl, verificationId, [
      'collectStudentPersonalInfo', 'collectTeacherPersonalInfo', 'collectMilitaryPersonalInfo',
      'collectFirstResponderPersonalInfo', 'collectSeniorPersonalInfo', 'collectPersonalInfo',
    ], this.baseUrl);
    return validateVerificationResponse(await this.#request('POST', url.slice(this.baseUrl.length), JSON.stringify(subjectData), { signal }), verificationId);
  }

  async getStatus(verificationId, statusUrl, signal) {
    if (!ID_PATTERN.test(verificationId)) throw new SheerFlowError('INVALID_VERIFICATION_ID', 'Verification ID is invalid.');
    const path = statusUrl ? assertStatusUrl(statusUrl, verificationId, this.baseUrl) : `verification/${verificationId}`;
    return validateVerificationResponse(await this.#request('GET', path, undefined, { signal }), verificationId);
  }

  async getDetails(verificationId, signal) {
    if (!ID_PATTERN.test(verificationId)) throw new SheerFlowError('INVALID_VERIFICATION_ID', 'Verification ID is invalid.');
    return await this.#request('GET', `verification/${verificationId}/details`, undefined, { signal });
  }

  async getProgramTheme(programId, signal) {
    if (!ID_PATTERN.test(programId)) throw new SheerFlowError('INVALID_PROGRAM_ID', 'Program ID is invalid.');
    const cached = this.themeCache.get(programId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const theme = await this.#request('GET', `program/${programId}/theme`, undefined, { signal });
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) throw new SheerFlowError('PROGRAM_THEME_INVALID', 'SheerID returned an invalid program theme.');
    this.themeCache.set(programId, { value:theme, expiresAt:Date.now() + 5 * 60_000 });
    return theme;
  }

  async searchOrganizations(programId, query, signal) {
    const term = String(query || '').trim();
    if (term.length < 2 || term.length > 80) throw new SheerFlowError('ORGANIZATION_QUERY_INVALID', 'Enter an organization name between 2 and 80 characters.');
    const theme = await this.getProgramTheme(programId, signal);
    const rawSearchUrl = theme?.config?.orgSearchUrl;
    let url;
    try { url = new URL(rawSearchUrl); } catch { throw new SheerFlowError('ORGANIZATION_SEARCH_UNAVAILABLE', 'This program does not provide a valid organization search URL.'); }
    if (url.origin !== 'https://orgsearch.sheerid.net' || url.pathname !== '/rest/organization/search'
      || url.username || url.password || url.hash) {
      throw new SheerFlowError('ORGANIZATION_SEARCH_URL_REJECTED', 'The program organization-search destination did not pass validation.');
    }
    url.searchParams.set('name', term);
    let response;
    try {
      response = await this.fetch(url, { method:'GET', headers:{accept:'application/json'}, redirect:'error',
        signal:signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new SheerFlowError('ORGANIZATION_SEARCH_FAILED', 'Could not reach the SheerID organization search service.');
    }
    if (!response.ok) throw new SheerFlowError('ORGANIZATION_SEARCH_FAILED', `Organization search failed with HTTP ${response.status}.`, { status:response.status });
    const results = await safeJson(response);
    if (!Array.isArray(results)) throw new SheerFlowError('ORGANIZATION_RESPONSE_INVALID', 'Organization search returned an invalid response.');
    return results.filter(item => Number.isSafeInteger(item?.id) && item.id > 0
      && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 250)
      .slice(0, 50).map(item => ({ id:item.id, name:item.name, country:String(item.country || '').slice(0,3), type:String(item.type || '').slice(0,40) }));
  }

  async initiateDocumentUpload(verificationId, submissionUrl, files, signal) {
    if (!ID_PATTERN.test(verificationId)) throw new SheerFlowError('INVALID_VERIFICATION_ID', 'Verification ID is invalid.');
    if (!Array.isArray(files) || files.length < 1 || files.length > 5) throw new SheerFlowError('INVALID_DOCUMENT_COUNT', 'Select between 1 and 5 documents.');
    const url = assertProviderStepUrl(submissionUrl, verificationId, ['docUpload'], this.baseUrl);
    const data = await this.#request('POST', url.slice(this.baseUrl.length), JSON.stringify({ files }), { signal });
    if (data?.verificationId !== verificationId || data.currentStep !== 'docUpload'
      || !Array.isArray(data.documents) || data.documents.length !== files.length) {
      throw new SheerFlowError('UPLOAD_RESPONSE_INVALID', 'SheerID returned an unexpected document-upload response.', { uncertain: true });
    }
    return data;
  }

  async uploadToSignedUrl(uploadUrl, bytes, mimeType, signal) {
    if (typeof uploadUrl !== 'string' || uploadUrl.length > 8192) {
      throw new SheerFlowError('INVALID_UPLOAD_URL', 'SheerID returned an invalid signed upload URL.');
    }
    let url;
    try { url = new URL(uploadUrl); } catch { throw new SheerFlowError('INVALID_UPLOAD_URL', 'SheerID returned an invalid signed upload URL.'); }
    const host = url.hostname.toLowerCase().replace(/\\.$/, '');
    const unsafeHost = isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test')
      || host.endsWith('.invalid') || host.endsWith('.home') || host.endsWith('.lan')
      || host.endsWith('.corp') || host.endsWith('.onion') || host === 'metadata.google.internal'
      || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || unsafeHost) {
      throw new SheerFlowError('INVALID_UPLOAD_URL', 'The signed upload URL did not pass destination checks.');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || !['application/pdf', 'image/png', 'image/jpeg'].includes(mimeType)) {
      throw new SheerFlowError('DOCUMENT_PAYLOAD_INVALID', 'Document bytes and MIME type are invalid.');
    }
    try {
      // The provider signature covers the full URL. Send the original string exactly as returned.
      const response = await this.fetch(uploadUrl, {
        method: 'PUT', headers: { 'content-type': mimeType, 'content-length': String(bytes.length) },
        body: bytes, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) throw new SheerFlowError('DOCUMENT_PUT_FAILED', `Document storage returned HTTP ${response.status}.`);
    } catch (error) {
      if (error instanceof SheerFlowError) throw error;
      throw new SheerFlowError('DOCUMENT_PUT_UNCERTAIN', 'The document upload outcome is unknown. Refresh status before attempting another upload.', { uncertain: true });
    }
  }

  async completeDocumentUpload(verificationId, submissionUrl, signal) {
    const url = assertProviderStepUrl(submissionUrl, verificationId, ['completeDocUpload'], this.baseUrl);
    return validateVerificationResponse(await this.#request('POST', url.slice(this.baseUrl.length), '', { signal }), verificationId);
  }
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  return Math.min(milliseconds, 60_000);
}

async function waitAbortably(milliseconds, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason || new Error('Aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
  signal?.throwIfAborted();
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

export { OFFICIAL_BASE, assertProviderStepUrl, assertStatusUrl };
