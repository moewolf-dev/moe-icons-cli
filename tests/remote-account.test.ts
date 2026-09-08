import { describe, expect, it, vi } from "vitest";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";
import { runRemoteAccountUseCase } from "../src/core/auth.js";
import type { CommandContext } from "../src/core/context.js";

function memoryStore(initial?: StoredSession): TokenStore {
  let value = initial;
  return {
    get: (accountId) => (value?.accountId === accountId ? value : undefined),
    getActive: () => value,
    set: (next) => { value = next; },
    delete: () => { value = undefined; },
    clear: () => { value = undefined; },
  };
}

const session: StoredSession = {
  accountId: "auth0|user", accessToken: "access-token", refreshToken: "refresh",
  expiresAt: Date.parse("2099-08-24T01:00:00Z"), scope: "openid profile offline_access",
  storedAt: Date.parse("2026-08-24T00:00:00Z"),
};

function context(env: Record<string, string> = {}): CommandContext {
  return {
    cwd: ".",
    env,
    signal: new AbortController().signal,
    now: () => new Date(),
    ui: {} as CommandContext["ui"],
  };
}

const ACCOUNT_OK = () => Response.json({ ok: true, accountId: "auth0|user", tier: "pro", entitlementStatus: "active", validUntil: "2099-01-01T00:00:00.000Z" }, { status: 200 });

describe("H2 runRemoteAccountUseCase", () => {
  it("queries /v1/cli/account and returns tier from the Worker", async () => {
    const fetchMock = vi.fn(() => ACCOUNT_OK()) as unknown as typeof fetch;
    const result = await runRemoteAccountUseCase(
      context({ MOEICONS_API_BASE_URL: "https://api.example.com" }),
      { tokenStore: memoryStore(session), fetch: fetchMock },
    );
    expect(result).toEqual({ tier: "pro", entitlementStatus: "active", validUntil: "2099-01-01T00:00:00.000Z" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/cli/account", expect.objectContaining({ method: "GET" }));
  });

  it("refreshes once on 401 then retries", async () => {
    let accountCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/oauth/token")) {
        return await Response.json({ access_token: "refreshed-access", expires_in: 60, refresh_token: "new-refresh" }, { status: 200 });
      }
      accountCalls += 1;
      return accountCalls === 1 ? new Response(null, { status: 401 }) : ACCOUNT_OK();
    }) as unknown as typeof fetch;
    const result = await runRemoteAccountUseCase(
      context({
        MOEICONS_API_BASE_URL: "https://api.example.com",
        MOEICONS_AUTH0_ISSUER: "https://example.auth0.com",
        MOEICONS_AUTH0_CLIENT_ID: "client123",
      }),
      { tokenStore: memoryStore(session), fetch: fetchMock },
    );
    expect(result?.tier).toBe("pro");
    expect(accountCalls).toBe(2);
  });

  it("returns tier free on 403 and never guesses a plan", async () => {
    const fetchMock = vi.fn(() => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const result = await runRemoteAccountUseCase(
      context({ MOEICONS_API_BASE_URL: "https://api.example.com" }),
      { tokenStore: memoryStore(session), fetch: fetchMock },
    );
    expect(result).toEqual({ tier: "free", entitlementStatus: "none", validUntil: null });
  });

  it("throws AUTH_ERROR when not logged in", async () => {
    await expect(
      runRemoteAccountUseCase(context(), { tokenStore: memoryStore(), fetch: vi.fn() as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });
});
