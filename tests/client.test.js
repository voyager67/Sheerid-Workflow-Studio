import test from 'node:test';
import assert from 'node:assert/strict';
import { SheerIDClient } from '../src/client.js';
import { SheerFlowError } from '../src/auth.js';

const verificationId = '0123456789abcdef01234567';
const programId = 'fedcba9876543210fedcba98';
const collectUrl = `https://services.sheerid.com/rest/v2/verification/${verificationId}/step/collectStudentPersonalInfo`;
const tokenManager = { async getToken() { return 'test-bearer-token'; } };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('create verification posts only the configured program ID to the official REST endpoint', async () => {
  let captured;
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return json({ verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] });
    }
  });
  const result = await client.createVerification(programId);
  assert.equal(captured.url, 'https://services.sheerid.com/rest/v2/verification');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, 'Bearer test-bearer-token');
  assert.deepEqual(JSON.parse(captured.options.body), { programId });
  assert.equal(result.verificationId, verificationId);
});

test('subject data is sent to the exact matching official submission step', async () => {
  let captured;
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async (url, options) => {
      captured = { url:String(url), options };
      return json({ verificationId, currentStep:'pending', errorIds:[] });
    }
  });
  const subject = { firstName:'Fictional', lastName:'Person', email:'fictional@example.test' };
  const result = await client.submitSubject(verificationId, collectUrl, subject);
  assert.equal(captured.url, collectUrl);
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(JSON.parse(captured.options.body), subject);
  assert.equal(result.currentStep, 'pending');
});

test('a submission URL from another origin is rejected before any subject data is sent', async () => {
  let calls = 0;
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async () => { calls += 1; return json({}); }
  });
  await assert.rejects(
    client.submitSubject(verificationId, `https://attacker.example/rest/v2/verification/${verificationId}/step/collectStudentPersonalInfo`, { email:'private@example.test' }),
    error => error.code === 'INVALID_SUBMISSION_URL'
  );
  assert.equal(calls, 0);
});

test('a mismatched verification ID in a successful provider response is rejected', async () => {
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async () => json({ verificationId:'aaaaaaaaaaaaaaaaaaaaaaaa', currentStep:'success', errorIds:[] })
  });
  await assert.rejects(client.getStatus(verificationId), error => error.code === 'VERIFICATION_ID_MISMATCH');
});

test('status GET refreshes an expired bearer token once after HTTP 401', async () => {
  const seen = [];
  let tokenCall = 0;
  const tokens = {
    async getToken({ forceRefresh = false } = {}) {
      tokenCall += 1;
      return forceRefresh ? 'fresh-token' : 'stale-token';
    }
  };
  const client = new SheerIDClient({
    tokenManager:tokens,
    fetchImpl: async (_url, options) => {
      seen.push(options.headers.authorization);
      return seen.length === 1
        ? json({ errorIds:['invalidApiToken'] }, 401)
        : json({ verificationId, currentStep:'pending', errorIds:[] });
    }
  });
  const result = await client.getStatus(verificationId);
  assert.equal(result.currentStep, 'pending');
  assert.deepEqual(seen, ['Bearer stale-token', 'Bearer fresh-token']);
  assert.equal(tokenCall, 2);
});

test('only SheerID apiRateLimitExceeded is automatically retried for a write', async () => {
  let calls = 0;
  const client = new SheerIDClient({
    tokenManager,
    retryBaseMs:1,
    random:() => 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? json({ errorIds:['apiRateLimitExceeded'] }, 429)
        : json({ verificationId, currentStep:'success', errorIds:[] });
    }
  });
  const result = await client.createVerification(programId);
  assert.equal(result.currentStep, 'success');
  assert.equal(calls, 2);
});

test('per-person verification limits are terminal and are never retried', async () => {
  let calls = 0;
  const client = new SheerIDClient({
    tokenManager,
    retryBaseMs:1,
    random:() => 0,
    fetchImpl: async () => {
      calls += 1;
      return json({ errorIds:['verificationLimitExceeded'] }, 429);
    }
  });
  await assert.rejects(client.createVerification(programId), error => error.code === 'BUSINESS_LIMIT_REACHED');
  assert.equal(calls, 1);
});

test('safe status reads retry transient 5xx responses with bounded backoff', async () => {
  let calls = 0;
  const client = new SheerIDClient({
    tokenManager,
    retryBaseMs:1,
    random:() => 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? json({ systemErrorMessage:'temporary' }, 503, { 'retry-after':'0.001' })
        : json({ verificationId, currentStep:'pending', errorIds:[] });
    }
  });
  const result = await client.getStatus(verificationId);
  assert.equal(result.currentStep, 'pending');
  assert.equal(calls, 2);
});

test('signed document upload preserves the provider URL and never forwards the OAuth bearer token', async () => {
  let captured;
  const signedUrl = 'https://bucket.s3.us-west-2.amazonaws.com/documents/a%2Fb.pdf?X-Amz-Signature=abc%2B123&X-Amz-Date=20261112T000000Z';
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response('', { status:200 });
    }
  });
  const bytes = Buffer.from('%PDF-1.7 fictional document');
  await client.uploadToSignedUrl(signedUrl, bytes, 'application/pdf');
  assert.equal(captured.url, signedUrl);
  assert.equal(captured.options.method, 'PUT');
  assert.equal(captured.options.headers.authorization, undefined);
  assert.equal(captured.options.headers['content-type'], 'application/pdf');
  assert.equal(captured.options.headers['content-length'], String(bytes.length));
  assert.equal(Buffer.from(captured.options.body).toString(), bytes.toString());
});

test('signed upload refuses insecure and local-network destinations before sending bytes', async () => {
  let calls = 0;
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async () => { calls += 1; return new Response('', { status:200 }); }
  });
  for (const url of [
    'http://storage.example.com/file?signature=x',
    'https://127.0.0.1/private?signature=x',
    'https://metadata.google.internal/latest/meta-data',
    'https://upload.localhost/file'
  ]) {
    await assert.rejects(
      client.uploadToSignedUrl(url, Buffer.from('x'), 'application/pdf'),
      error => error.code === 'INVALID_UPLOAD_URL'
    );
  }
  assert.equal(calls, 0);
});

test('organization lookup uses the configured SheerID search host and preserves program filters', async () => {
  const calls = [];
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async (url, options) => {
      calls.push({ url:String(url), options });
      if (String(url).endsWith('/program/' + programId + '/theme')) {
        return json({ config:{ orgSearchUrl:'https://orgsearch.sheerid.net/rest/organization/search?country=US&type=UNIVERSITY&name=' } });
      }
      return json([{ id:7001, name:'Example University', country:'US', type:'UNIVERSITY' }]);
    }
  });
  const result = await client.searchOrganizations(programId, 'Example University');
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).origin, 'https://orgsearch.sheerid.net');
  assert.equal(new URL(calls[1].url).pathname, '/rest/organization/search');
  assert.equal(new URL(calls[1].url).searchParams.get('country'), 'US');
  assert.equal(new URL(calls[1].url).searchParams.get('name'), 'Example University');
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.deepEqual(result, [{ id:7001, name:'Example University', country:'US', type:'UNIVERSITY' }]);
});

test('program theme cannot redirect organization lookup to an unapproved host or path', async () => {
  let calls = 0;
  const client = new SheerIDClient({
    tokenManager,
    fetchImpl: async url => {
      calls += 1;
      if (String(url).includes('/theme')) return json({ config:{ orgSearchUrl:'https://orgsearch.sheerid.net/rest/organization/search-evil' } });
      return json([]);
    }
  });
  await assert.rejects(client.searchOrganizations(programId, 'Example'), error => error.code === 'ORGANIZATION_SEARCH_URL_REJECTED');
  assert.equal(calls, 1);
});

test('an ambiguous 5xx write is surfaced as uncertain and is not automatically replayed', async () => {
  let calls = 0;
  const client = new SheerIDClient({
    tokenManager,
    retryBaseMs:1,
    random:() => 0,
    fetchImpl: async () => { calls += 1; return json({ systemErrorMessage:'temporary' }, 503); }
  });
  await assert.rejects(client.createVerification(programId), error => error.uncertain === true);
  assert.equal(calls, 1);
});


test('subject submission and document completion also reject mismatched verification IDs', async () => {
  const wrongId='aaaaaaaaaaaaaaaaaaaaaaaa';
  const client=new SheerIDClient({
    tokenManager,
    fetchImpl:async () => json({ verificationId:wrongId, currentStep:'pending', errorIds:[] })
  });
  await assert.rejects(
    client.submitSubject(verificationId, collectUrl, { firstName:'Fictional' }),
    error => error.code === 'VERIFICATION_ID_MISMATCH'
  );
  const completeUrl=`https://services.sheerid.com/rest/v2/verification/${verificationId}/step/completeDocUpload`;
  await assert.rejects(
    client.completeDocumentUpload(verificationId, completeUrl),
    error => error.code === 'VERIFICATION_ID_MISMATCH'
  );
});
