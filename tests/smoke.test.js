import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthTokenManager, requiredEnv, SheerFlowError } from '../src/auth.js';
import { inspectDocument } from '../src/documents.js';
import { validateVerificationResponse } from '../src/client.js';
import { createSheerFlowServer } from '../src/server.js';

test('requiredEnv refuses unset and placeholder credentials', () => {
  assert.throws(() => requiredEnv({},'SHEERID_CLIENT_SECRET'), { code:'CONFIG_REQUIRED' });
  assert.throws(() => requiredEnv({TOKEN:'replace-with-secret'},'TOKEN'), { code:'CONFIG_REQUIRED' });
  assert.equal(requiredEnv({TOKEN:'configured-secret'},'TOKEN'),'configured-secret');
});

test('OAuth token manager caches a successful bearer token', async () => {
  let calls = 0;
  const manager = new OAuthTokenManager({
    clientId:'client', clientSecret:'secret',
    fetchImpl:async (_url,options) => {
      calls += 1;
      assert.equal(options.method,'POST');
      return new Response(JSON.stringify({access_token:'test-token',token_type:'Bearer',expires_in:3600}),{status:200});
    }
  });
  assert.equal(await manager.getToken(),'test-token');
  assert.equal(await manager.getToken(),'test-token');
  assert.equal(calls,1);
});

test('document validator checks content signature and extension', () => {
  const pdf = Buffer.from('%PDF-1.7\nfictional fixture');
  assert.equal(inspectDocument(pdf,'sample.pdf').mimeType,'application/pdf');
  assert.throws(() => inspectDocument(pdf,'sample.png'), { code:'DOCUMENT_EXTENSION_MISMATCH' });
  assert.throws(() => inspectDocument(Buffer.from('not a PDF'),'sample.pdf'), { code:'DOCUMENT_TYPE_INVALID' });
});

test('provider response validation rejects malformed verification IDs', () => {
  assert.equal(validateVerificationResponse({
    verificationId:'0123456789abcdef01234567', currentStep:'pending', errorIds:[]
  }).currentStep,'pending');
  assert.throws(() => validateVerificationResponse({
    verificationId:'not-an-id', currentStep:'pending', errorIds:[]
  }), { code:'API_RESPONSE_INVALID' });
});

test('demo dashboard login, job creation and queue listing work without provider secrets', async t => {
  const app = createSheerFlowServer({
    env:{
      SHEERFLOW_MODE:'demo',
      SHEERFLOW_DASHBOARD_PASSWORD:'local-demo-password-2026-secure'
    },
    port:0
  });
  const address = await app.start();
  t.after(() => app.close());
  const login = await fetch(`${address}/api/login`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({password:'local-demo-password-2026-secure'})
  });
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const {csrfToken} = await login.json();
  const create = await fetch(`${address}/api/jobs`,{
    method:'POST',
    headers:{cookie,'content-type':'application/json','x-csrf-token':csrfToken},
    body:JSON.stringify({
      consent:true,
      clientRequestId:'00000000-0000-4000-8000-000000000001',
      subjectData:{firstName:'Alex',lastName:'Morgan',email:'alex@example.test'},
      demoScenario:'approved'
    })
  });
  assert.equal(create.status,202);
  const payload = await create.json();
  assert.ok(payload.job.id);
  const listing = await fetch(`${address}/api/jobs`,{headers:{cookie}});
  assert.equal(listing.status,200);
  assert.equal((await listing.json()).jobs.length,1);
});
