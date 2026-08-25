import { describe, expect, it, vi } from "vitest";
import { main, type CliRuntime } from "../src/cli.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";
import { runSessionStatusUseCase } from "../src/core/auth.js";
import type { CommandContext } from "../src/core/context.js";

function memoryStore(initial?: StoredSession): TokenStore {
  let value = initial;
  return {
    get: (accountId) => value?.accountId === accountId ? value : undefined,
    getActive: () => value,
    set: (next) => { value = next; },
    delete: () => { value = undefined; },
    clear: () => { value = undefined; },
  };
}

function runtime(auth: NonNullable<CliRuntime["auth"]>, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      cwd: () => ".", stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text),
      env, isTTY: () => false, auth,
    } satisfies CliRuntime,
    out, err,
  };
}

const session: StoredSession = {
  accountId: "auth0|user", accessToken: "access", refreshToken: "refresh",
  expiresAt: Date.parse("2099-08-24T01:00:00Z"), scope: "openid profile email offline_access",
  storedAt: Date.parse("2026-08-24T00:00:00Z"),
};

describe("auth command adapters", () => {
  it("login opens the trusted page, exchanges and emits redacted JSON", async () => {
    const store = memoryStore();
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 201, data: { loginId: "id", pollingToken: "poll", browserUrl: "https://moeicons.com/cli-login?loginId=id", intervalSeconds: 5, expiresAt: "2099-01-01T00:00:00Z" } })
      .mockResolvedValueOnce({ status: 200, data: { status: "complete", exchangeCode: "exchange" } })
      .mockResolvedValueOnce({ status: 200, data: { accountId: session.accountId, accessToken: session.accessToken, refreshToken: session.refreshToken, expiresIn: 900 } });
    const fixture = runtime({ tokenStore: store, request, openBrowser: vi.fn(async () => undefined), sleep: vi.fn(async () => undefined) });
    expect(await main(["login", "--json"], fixture.runtime)).toBe(0);
    const body = JSON.parse(fixture.out.join(""));
    expect(body).toMatchObject({ ok: true, account: { accountId: "auth0|user" } });
    expect(fixture.out.join("")).not.toContain("refresh");
  });

  it("account refreshes an expired session once and never prints tokens", async () => {
    const store = memoryStore({ ...session, expiresAt: 0 });
    const fixture = runtime({ tokenStore: store, fetch: vi.fn(async () => Response.json({ access_token: "new-access", expires_in: 60 })) }, {
      MOEICONS_AUTH0_ISSUER: "https://tenant.auth0.com", MOEICONS_AUTH0_CLIENT_ID: "client",
    });
    expect(await main(["account", "--json"], fixture.runtime)).toBe(0);
    expect(fixture.out.join("")).not.toContain("new-access");
    expect(JSON.parse(fixture.out.join(""))).toMatchObject({ ok: true, account: { accountId: "auth0|user" } });
  });

  it("logout clears local credentials even when remote revoke fails", async () => {
    const store = memoryStore(session);
    const fixture = runtime({ tokenStore: store, fetch: vi.fn(async () => new Response(null, { status: 503 })) }, {
      MOEICONS_AUTH0_ISSUER: "https://tenant.auth0.com", MOEICONS_AUTH0_CLIENT_ID: "client",
    });
    expect(await main(["logout", "--json"], fixture.runtime)).toBe(0);
    expect(JSON.parse(fixture.out.join(""))).toEqual({ ok: true, revoked: false });
    expect(store.getActive()).toBeUndefined();
    const again = runtime({ tokenStore: store });
    expect(await main(["logout", "--json"], again.runtime)).toBe(0);
    expect(JSON.parse(again.out.join(""))).toEqual({ ok: true, revoked: true });
  });

  it("reports confirmed remote revocation while keeping tokens out of output", async () => {
    const store = memoryStore(session);
    const fixture = runtime({ tokenStore: store, fetch: vi.fn(async () => new Response(null, { status: 200 })) }, {
      MOEICONS_AUTH0_ISSUER: "https://tenant.auth0.com", MOEICONS_AUTH0_CLIENT_ID: "client",
    });
    expect(await main(["logout", "--json"], fixture.runtime)).toBe(0);
    expect(JSON.parse(fixture.out.join(""))).toEqual({ ok: true, revoked: true });
    expect(fixture.out.join("")).not.toContain(session.refreshToken);
  });

  it("hides login only for a current or successfully refreshed session", async () => {
    const context = (env: Record<string, string | undefined>): CommandContext => ({
      cwd: ".", env, signal: new AbortController().signal, now: () => new Date("2026-08-24T00:00:00Z"),
      ui: { select: async () => undefined, confirm: async () => undefined, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
    });
    await expect(runSessionStatusUseCase(context({}), { tokenStore: memoryStore(session) })).resolves.toMatchObject({ kind: "authenticated" });
    await expect(runSessionStatusUseCase(context({}), { tokenStore: memoryStore({ ...session, expiresAt: 0 }) })).resolves.toMatchObject({ kind: "signed-out", reason: "stored session is expired" });
    await expect(runSessionStatusUseCase(context({}), { tokenStore: memoryStore() })).resolves.toEqual({ kind: "signed-out" });
    const authEnv = { MOEICONS_AUTH0_ISSUER: "https://tenant.auth0.com", MOEICONS_AUTH0_CLIENT_ID: "client" };
    await expect(runSessionStatusUseCase(context(authEnv), { tokenStore: memoryStore({ ...session, expiresAt: 0 }), fetch: vi.fn(async () => { throw new TypeError("offline"); }) })).resolves.toMatchObject({ kind: "unknown", reason: "offline" });
    await expect(runSessionStatusUseCase(context(authEnv), { tokenStore: memoryStore({ ...session, expiresAt: 0 }), fetch: vi.fn(async () => Response.json({ access_token: "new", expires_in: 60 })) })).resolves.toMatchObject({ kind: "authenticated" });
    await expect(runSessionStatusUseCase(context(authEnv), { tokenStore: memoryStore({ ...session, expiresAt: 0 }), fetch: vi.fn(async () => Response.json({}, { status: 401 })) })).resolves.toMatchObject({ kind: "signed-out", reason: "Auth0 refresh failed" });
  });

  it("allows isolated tests to bypass native keychains only with an explicit token directory", async () => {
    const systemTokenStore = vi.fn(() => memoryStore(session));
    const context: CommandContext = {
      cwd: ".", env: { MOEICONS_DISABLE_SYSTEM_KEYCHAIN: "1", MOEICONS_TOKEN_STORE_DIR: "/isolated" },
      signal: new AbortController().signal, now: () => new Date(),
      ui: { select: async () => undefined, confirm: async () => { throw new Error("must not prompt"); }, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
    };
    await expect(runSessionStatusUseCase(context, { systemTokenStore, fileTokenStore: () => memoryStore() })).resolves.toEqual({ kind: "signed-out" });
    expect(systemTokenStore).not.toHaveBeenCalled();
  });
});
