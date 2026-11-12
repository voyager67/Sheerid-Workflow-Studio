import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheerFlowServer } from '../src/server.js';

const password = 'local-dashboard-password-for-tests-2026';
async function startServer(t, overrides = {}) {
  const app = createSheerFlowServer({
    env:{ SHEERFLOW_MODE:'demo', SHEERFLOW_DASHBOARD_PASSWORD:password, ...overrides },
    port:0
  });
  const address = await app.start();
  t.after(() => app.close());
  return { app, address };
}
async function signIn(address, pass = password) {
  const response = await fetch(`${address}/api/login`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ password:pass })
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const data = await response.json();
  return { response, cookie, csrf:data.csrfToken };
}

test('dashboard serves its real SVG banner asset and no longer exposes a broken PNG route', async t => {
  const { address } = await startServer(t);
  const auth = await signIn(address);
  const [home, banner, oldBanner] = await Promise.all([
    fetch(address),
    fetch(`${address}/brand.svg`),
    fetch(`${address}/brand.png`, { headers:{ cookie:auth.cookie } })
  ]);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(banner.status, 200);
  assert.match(banner.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(oldBanner.status, 404);
});

test('dashboard sends restrictive security headers on static and API responses', async t => {
  const { address } = await startServer(t);
  const response = await fetch(address);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('login rejects incorrect passwords and issues an HttpOnly SameSite session on success', async t => {
  const { address } = await startServer(t);
  const failed = await signIn(address, 'wrong-password');
  assert.equal(failed.response.status, 401);
  const signedIn = await signIn(address);
  assert.equal(signedIn.response.status, 200);
  assert.ok(signedIn.cookie.startsWith('sheerflow_session='));
  assert.match(signedIn.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(signedIn.response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal(typeof signedIn.csrf, 'string');
  assert.ok(signedIn.csrf.length >= 32);
});

test('state-changing requests require both a session and a CSRF token', async t => {
  const { address } = await startServer(t);
  const signedIn = await signIn(address);
  const withoutToken = await fetch(`${address}/api/jobs`, {
    method:'POST',
    headers:{ cookie:signedIn.cookie, 'content-type':'application/json' },
    body:'{}'
  });
  assert.equal(withoutToken.status, 403);
  const withoutSession = await fetch(`${address}/api/logout`, {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-csrf-token':signedIn.csrf },
    body:'{}'
  });
  assert.equal(withoutSession.status, 401);
});

test('cross-origin writes are rejected even with a valid local session and CSRF token', async t => {
  const { address } = await startServer(t);
  const signedIn = await signIn(address);
  const response = await fetch(`${address}/api/logout`, {
    method:'POST',
    headers:{
      cookie:signedIn.cookie,
      origin:'https://attacker.example',
      'content-type':'application/json',
      'x-csrf-token':signedIn.csrf
    },
    body:'{}'
  });
  assert.equal(response.status, 403);
});

test('unknown API paths return an actual HTTP 404', async t => {
  const { address } = await startServer(t);
  const signedIn = await signIn(address);
  const response = await fetch(`${address}/api/this-route-does-not-exist`, {
    headers:{ cookie:signedIn.cookie }
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});

test('a dashboard job can be created through the authenticated local API', async t => {
  const { address } = await startServer(t);
  const signedIn = await signIn(address);
  const response = await fetch(`${address}/api/jobs`, {
    method:'POST',
    headers:{
      cookie:signedIn.cookie,
      'content-type':'application/json',
      'x-csrf-token':signedIn.csrf
    },
    body:JSON.stringify({
      consent:true,
      clientRequestId:'00000000-0000-4000-8000-000000000021',
      subjectData:{ firstName:'Demo', lastName:'Person', email:'demo@example.test' },
      demoScenario:'approved'
    })
  });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.ok(result.job.id);
  assert.equal(result.job.status, 'running');
});

test('demo mode rejects live external credential requirements and clearly identifies itself', async t => {
  const { address } = await startServer(t);
  const signedIn = await signIn(address);
  const response = await fetch(`${address}/api/config`, { headers:{ cookie:signedIn.cookie } });
  const config = await response.json();
  assert.equal(config.mode, 'demo');
  assert.equal(config.programId, 'DEMO');
  assert.match(config.programLabel, /no external API calls/i);
  assert.equal('clientSecret' in config, false);
});


test('multipart upload preserves PDF bytes through the local server boundary', async t => {
  const verificationId = '0123456789abcdef01234567';
  const collectUrl = `https://services.sheerid.com/rest/v2/verification/${verificationId}/step/collectStudentPersonalInfo`;
  const docUrl = `https://services.sheerid.com/rest/v2/verification/${verificationId}/step/docUpload`;
  const completeUrl = `https://services.sheerid.com/rest/v2/verification/${verificationId}/step/completeDocUpload`;
  const expected = Buffer.from('%PDF-1.7 fictional upload bytes');
  let uploaded;
  const fakeClient = {
    async createVerification() {
      return { verificationId, currentStep:'collectStudentPersonalInfo', submissionUrl:collectUrl, errorIds:[] };
    },
    async submitSubject() {
      return { verificationId, currentStep:'docUpload', submissionUrl:docUrl, errorIds:[] };
    },
    async initiateDocumentUpload(id, url, files) {
      assert.equal(id, verificationId);
      assert.equal(url, docUrl);
      assert.equal(files.length, 1);
      return {
        verificationId, currentStep:'docUpload', errorIds:[],
        documents:[{
          uploadUrl:'https://bucket.s3.amazonaws.com/fictional.pdf?signature=mock',
          mimeType:'application/pdf', fileSize:files[0].fileSize, errors:[]
        }],
        submissionUrl:completeUrl
      };
    },
    async uploadToSignedUrl(_url, bytes) { uploaded = Buffer.from(bytes); },
    async completeDocumentUpload() {
      return { verificationId, currentStep:'pending', errorIds:[], statusUrl:`https://services.sheerid.com/rest/v2/verification/${verificationId}` };
    }
  };
  const app = createSheerFlowServer({
    env:{ SHEERFLOW_MODE:'demo', SHEERFLOW_DASHBOARD_PASSWORD:password },
    client:fakeClient,
    port:0
  });
  const address = await app.start();
  t.after(() => app.close());
  const auth = await signIn(address);
  const created = await fetch(`${address}/api/jobs`, {
    method:'POST',
    headers:{ cookie:auth.cookie, 'content-type':'application/json', 'x-csrf-token':auth.csrf },
    body:JSON.stringify({
      consent:true,
      clientRequestId:'00000000-0000-4000-8000-000000000031',
      subjectData:{ firstName:'Fictional', lastName:'Person', email:'fictional@example.test' }
    })
  });
  assert.equal(created.status,202);
  const job = (await created.json()).job;
  let current;
  for (let attempt=0; attempt<100; attempt++) {
    const response=await fetch(`${address}/api/jobs/${job.id}`,{headers:{cookie:auth.cookie}});
    current=(await response.json()).job;
    if(current.status==='needs_document') break;
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  assert.equal(current.status,'needs_document');

  const form=new FormData();
  form.append('documents',new Blob([expected],{type:'application/pdf'}),'fictional.pdf');
  const upload=await fetch(`${address}/api/jobs/${job.id}/documents`, {
    method:'POST',
    headers:{cookie:auth.cookie,'x-csrf-token':auth.csrf},
    body:form
  });
  const responseText=await upload.text();
  assert.equal(upload.status,200,responseText);
  assert.deepEqual(uploaded,expected);
  const result=JSON.parse(responseText);
  assert.equal(result.job.status,'waiting');
});
