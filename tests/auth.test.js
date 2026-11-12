import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthTokenManager, SheerFlowError, requiredEnv } from '../src/auth.js';

test('requiredEnv trims configured values and rejects missing or placeholder values', () => {
  assert.throws(() => requiredEnv({}, 'SHEERID_CLIENT_SECRET'), error => error.code === 'CONFIG_REQUIRED');
  assert.throws(() => requiredEnv({ TOKEN:'replace-with-secret' }, 'TOKEN'), error => error.code === 'CONFIG_REQUIRED');
  assert.equal(requiredEnv({ TOKEN:'  configured-secret  ' }, 'TOKEN'), 'configured-secret');
});

test('OAuth sends the client-credentials grant and the documented REST audience', async () => {
  let request;
  const manager = new OAuthTokenManager({
    clientId:'fictional-client-id',
    clientSecret:'fictional-client-secret',
    fetchImpl:async (url, options) => {
      request={url:String(url),options};
      return new Response(JSON.stringify({
        access_token:'fictional-access-token-value',
        token_type:'Bearer',
        expires_in:3600
      }),{status:200});
    }
  });
  assert.equal(await manager.getToken(),'fictional-access-token-value');
  assert.equal(request.url,'https://auth.sheerid.com/oauth/token');
  assert.equal(request.options.method,'POST');
  const body=new URLSearchParams(request.options.body);
  assert.equal(body.get('grant_type'),'client_credentials');
  assert.equal(body.get('audience'),'https://services.sheerid.com/rest/');
  assert.equal(body.get('client_id'),'fictional-client-id');
  assert.equal(body.get('client_secret'),'fictional-client-secret');
});

test('concurrent token requests share one in-flight OAuth exchange', async () => {
  let calls=0;
  const manager=new OAuthTokenManager({
    clientId:'fictional-client-id',
    clientSecret:'fictional-client-secret',
    fetchImpl:async () => {
      calls+=1;
      await new Promise(resolve=>setTimeout(resolve,5));
      return new Response(JSON.stringify({
        access_token:'fictional-access-token-value',
        token_type:'Bearer',
        expires_in:3600
      }),{status:200});
    }
  });
  const tokens=await Promise.all([manager.getToken(),manager.getToken(),manager.getToken()]);
  assert.deepEqual(tokens,['fictional-access-token-value','fictional-access-token-value','fictional-access-token-value']);
  assert.equal(calls,1);
});

test('malformed OAuth token types are rejected as a controlled error', async () => {
  const manager=new OAuthTokenManager({
    clientId:'id',
    clientSecret:'secret',
    fetchImpl:async ()=>new Response(JSON.stringify({
      access_token:'fictional-access-token-value',
      token_type:42,
      expires_in:3600
    }),{status:200})
  });
  await assert.rejects(manager.getToken(),error =>
    error instanceof SheerFlowError && error.code === 'OAUTH_RESPONSE_INVALID'
  );
});

test('provider OAuth rejection does not leak the response body or client secret', async () => {
  const secret='fictional-secret-that-must-not-be-echoed';
  const manager=new OAuthTokenManager({
    clientId:'fictional-client-id',
    clientSecret:secret,
    fetchImpl:async ()=>new Response(JSON.stringify({ error:'invalid_client', echo:secret }),{status:401})
  });
  await assert.rejects(manager.getToken(),error => {
    assert.equal(error.code,'OAUTH_REJECTED');
    assert.equal(error.message.includes(secret),false);
    return true;
  });
});
