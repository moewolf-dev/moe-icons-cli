import { createLoginState, createPkcePair } from './pkce.js';
import type { StoredSession, TokenStore } from './token-store.js';
import { CliError } from '../errors/index.js';

export interface DeviceLoginConfig {
  readonly apiBaseUrl: string;
  readonly websiteOrigin: string;
  readonly auth0Issuer: string;
  readonly auth0ClientId: string;
}

interface CreateResponse {
  readonly loginId: string;
  readonly pollingToken: string;
  readonly browserUrl: string;
  readonly expiresAt: string;
}

interface PollResponse {
  readonly status: 'pending' | 'complete';
  readonly exchangeCode?: string;
}

interface ExchangeResponse {
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export interface DeviceLoginDependencies {
  readonly request: <T>(path: string, options: { method: 'GET' | 'POST' | 'DELETE'; auth?: string; body?: unknown; signal?: AbortSignal }) => Promise<{ status: number; data: T }>;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly tokenStore: TokenStore;
  readonly now: () => number;
}

function assertBrowserUrl(value: string, expectedOrigin: string): void {
  const url = new URL(value);
  if (url.origin !== new URL(expectedOrigin).origin || url.pathname !== '/cli-login') {
    throw new CliError('AUTH_ERROR', 'backend returned an untrusted login URL');
  }
}

export async function loginWithDeviceSession(
  config: DeviceLoginConfig,
  deps: DeviceLoginDependencies,
  signal?: AbortSignal,
): Promise<StoredSession> {
  const pkce = createPkcePair();
  const state = createLoginState();
  const created = await deps.request<CreateResponse>('/v1/cli-login-sessions', {
    method: 'POST', body: { codeChallenge: pkce.challenge, clientNonce: state.nonce, state: state.state }, ...(signal ? { signal } : {}),
  });
  assertBrowserUrl(created.data.browserUrl, config.websiteOrigin);
  await deps.openBrowser(created.data.browserUrl);
  const auth = `Bearer ${created.data.pollingToken}`;
  const sessionPath = `/v1/cli-login-sessions/${encodeURIComponent(created.data.loginId)}`;
  try {
    while (deps.now() < Date.parse(created.data.expiresAt)) {
      if (signal?.aborted) throw new CliError('CANCELLED', 'login cancelled');
      const polled = await deps.request<PollResponse>(sessionPath, { method: 'GET', auth, ...(signal ? { signal } : {}) });
      if (polled.status === 200 && polled.data.status === 'complete' && polled.data.exchangeCode) {
        const exchanged = await deps.request<ExchangeResponse>(`${sessionPath}/exchange`, {
          method: 'POST', auth,
          body: { exchangeCode: polled.data.exchangeCode, clientNonce: state.nonce, codeVerifier: pkce.verifier },
          ...(signal ? { signal } : {}),
        });
        const stored: StoredSession = {
          accountId: exchanged.data.accountId,
          accessToken: exchanged.data.accessToken,
          refreshToken: exchanged.data.refreshToken,
          expiresAt: deps.now() + exchanged.data.expiresIn * 1000,
          scope: 'openid profile email offline_access',
          storedAt: deps.now(),
        };
        deps.tokenStore.set(stored);
        return stored;
      }
      await deps.sleep(1500, signal);
    }
    throw new CliError('AUTH_ERROR', 'login session expired');
  } catch (error) {
    try { await deps.request(sessionPath, { method: 'DELETE', auth }); } catch { /* best effort */ }
    throw error;
  }
}

export async function refreshAuth0Session(
  config: DeviceLoginConfig,
  session: StoredSession,
  deps: { fetch: typeof fetch; tokenStore: TokenStore; now: () => number; signal?: AbortSignal },
): Promise<StoredSession> {
  const response = await deps.fetch(`${config.auth0Issuer.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: config.auth0ClientId, refresh_token: session.refreshToken }),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== 'string') throw new CliError('AUTH_ERROR', 'Auth0 refresh failed');
  const updated: StoredSession = {
    ...session,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : session.refreshToken,
    expiresAt: deps.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000,
    storedAt: deps.now(),
  };
  deps.tokenStore.set(updated);
  return updated;
}
