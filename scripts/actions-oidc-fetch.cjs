'use strict';

// A local marker is replaced immediately before the request; it is never a credential.
const ACTIONS_OIDC_MARKER = 'github-actions-oidc-pro-package-set-request';
const AUDIENCE = 'https://api.moeicons.com/pro-package-set';

function createActionsOidcFetch({ apiBaseUrl, fetcher = fetch, env = process.env, now = Date.now }) {
  const api = new URL(apiBaseUrl);
  if (api.protocol !== 'https:' || api.username || api.password) throw new Error('Pro API origin must be HTTPS');
  let cached = null;
  let pending = null;
  async function oidcToken() {
    if (cached && now() < cached.refreshAt) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
      const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      if (!requestUrl || !requestToken || /[\r\n]/.test(requestToken)) throw new Error('GitHub Actions OIDC is unavailable: id-token permission is required');
      const url = new URL(requestUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid GitHub Actions OIDC request URL');
      url.searchParams.set('audience', AUDIENCE);
      const response = await fetcher(url, { headers: { Authorization: `bearer ${requestToken}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`GitHub Actions OIDC request failed (HTTP ${response.status})`);
      const result = await response.json();
      const token = result && result.value;
      if (typeof token !== 'string' || token.length < 32 || token.length > 8192 || /[\r\n]/.test(token)) throw new Error('GitHub Actions OIDC response is invalid');
      // GitHub tokens are short-lived; cache only briefly and refresh for long jobs.
      cached = { token, refreshAt: now() + 60_000 };
      return token;
    })();
    try { return await pending; } finally { pending = null; }
  }
  return async function actionsOidcFetch(url, options = {}) {
    const headers = new Headers(options.headers);
    if (headers.get('Authorization') === `Bearer ${ACTIONS_OIDC_MARKER}`) {
      const target = new URL(url);
      if (target.origin !== api.origin || !target.pathname.startsWith('/v1/icon-library/pro/package-set')) throw new Error('refusing to send GitHub OIDC credential outside the Pro package-set API');
      headers.set('Authorization', `Bearer ${await oidcToken()}`);
    }
    return fetcher(url, { ...options, headers });
  };
}
module.exports = { ACTIONS_OIDC_MARKER, AUDIENCE, createActionsOidcFetch };
