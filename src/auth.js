export class SheerFlowError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'SheerFlowError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.uncertain = options.uncertain === true;
    this.details = options.details;
  }
}

export function requiredEnv(env, key) {
  const value = env[key]?.trim();
  if (!value || value.startsWith('replace-with-')) {
    throw new SheerFlowError('CONFIG_REQUIRED', `Missing required environment variable: ${key}`);
  }
  return value;
}

export class OAuthTokenManager {
  #token = null;
  #expiresAt = 0;
  #inflight = null;

  constructor({ clientId, clientSecret, authUrl = 'https://auth.sheerid.com/oauth/token', fetchImpl = fetch, clock = Date.now }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.authUrl = authUrl;
    this.fetch = fetchImpl;
    this.clock = clock;
  }

  async getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.#token && this.clock() < this.#expiresAt - 300_000) return this.#token;
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#requestToken();
    try { return await this.#inflight; }
    finally { this.#inflight = null; }
  }

  async #requestToken() {
    let response;
    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        audience: 'https://services.sheerid.com/rest/',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
      response = await this.fetch(this.authUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new SheerFlowError('OAUTH_UNAVAILABLE', 'Could not reach the SheerID OAuth service. Check the network and try again.');
    }
    const data = await safeJson(response);
    if (!response.ok) {
      throw new SheerFlowError('OAUTH_REJECTED', 'SheerID rejected the OAuth credentials. Verify the application ID, secret and API role.', { status: response.status });
    }
    if (typeof data?.access_token !== 'string' || data.access_token.length < 16
      || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(data.expires_in) || data.expires_in < 60) {
      throw new SheerFlowError('OAUTH_RESPONSE_INVALID', 'SheerID OAuth returned an invalid token response.');
    }
    this.#token = data.access_token;
    this.#expiresAt = this.clock() + data.expires_in * 1000;
    return this.#token;
  }
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}
