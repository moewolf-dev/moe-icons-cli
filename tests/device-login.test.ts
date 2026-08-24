import { describe, expect, it, vi } from 'vitest';
import { loginWithDeviceSession, refreshAuth0Session } from '../src/auth/device-login.js';
import type { StoredSession, TokenStore } from '../src/auth/token-store.js';

function memoryStore() {
  let value: StoredSession | undefined;
  const store: TokenStore = { get: () => value, set: (next) => { value = next; }, delete: () => { value = undefined; } };
  return { store, get: () => value };
}

const config = { apiBaseUrl: 'https://api.moeicons.com', websiteOrigin: 'https://moeicons.com', auth0Issuer: 'https://tenant.auth0.com', auth0ClientId: 'client' };

describe('device-style Auth0 login', () => {
  it('creates, polls, exchanges and stores only after success', async () => {
    const memory = memoryStore();
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 201, data: { loginId: 'id', pollingToken: 'poll', browserUrl: 'https://moeicons.com/cli-login?loginId=id', expiresAt: '2026-08-24T00:10:00Z' } })
      .mockResolvedValueOnce({ status: 202, data: { status: 'pending' } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'complete', exchangeCode: 'exchange' } })
      .mockResolvedValueOnce({ status: 200, data: { accountId: 'auth0|user', accessToken: 'access', refreshToken: 'refresh', expiresIn: 900 } });
    const opened: string[] = [];
    const result = await loginWithDeviceSession(config, {
      request, openBrowser: async (url) => { opened.push(url); }, sleep: async () => undefined,
      tokenStore: memory.store, now: () => Date.parse('2026-08-24T00:00:00Z'),
    });
    expect(opened).toEqual(['https://moeicons.com/cli-login?loginId=id']);
    expect(result.accountId).toBe('auth0|user');
    expect(memory.get()?.refreshToken).toBe('refresh');
    expect(request.mock.calls[3]?.[1].body).toMatchObject({ exchangeCode: 'exchange' });
  });

  it('rejects a browser URL outside the fixed website origin', async () => {
    const memory = memoryStore();
    await expect(loginWithDeviceSession(config, {
      request: async <T>() => ({ status: 201, data: { loginId: 'id', pollingToken: 'poll', browserUrl: 'https://evil.example/cli-login', expiresAt: '2026-08-24T00:10:00Z' } as T }),
      openBrowser: async () => undefined, sleep: async () => undefined, tokenStore: memory.store,
      now: () => Date.parse('2026-08-24T00:00:00Z'),
    })).rejects.toThrow('untrusted login URL');
    expect(memory.get()).toBeUndefined();
  });

  it('uses Auth0 refresh rotation and preserves the old refresh token when omitted', async () => {
    const memory = memoryStore();
    const old: StoredSession = { accountId: 'auth0|u', accessToken: 'old-a', refreshToken: 'old-r', expiresAt: 0, scope: 'openid', storedAt: 0 };
    const updated = await refreshAuth0Session(config, old, {
      fetch: vi.fn(async () => new Response(JSON.stringify({ access_token: 'new-a', expires_in: 60 }), { status: 200 })),
      tokenStore: memory.store, now: () => 1000,
    });
    expect(updated).toMatchObject({ accessToken: 'new-a', refreshToken: 'old-r', expiresAt: 61000 });
  });
});
