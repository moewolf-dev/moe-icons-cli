import { describe, it, expect } from "vitest";
import { createPkcePair, createLoginState } from "../src/auth/pkce.js";
import { buildAuthorizationUrl, hashApiKey, exchangeAuthorizationCode } from "../src/auth/login.js";
import { requestJson, verifyApiKey } from "../src/api/client.js";
import { CliError } from "../src/errors/index.js";

const AUTH_CONFIG = {
  issuer: "https://example.auth0.com",
  clientId: "client123",
  audience: "https://api.moeicons.com",
  redirectPath: "/callback",
  scope: "openid profile",
};

describe("createPkcePair", () => {
  it("produces a verifier and S256 challenge with valid lengths", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge.length).toBeGreaterThan(0);
  });

  it("produces different pairs on each call", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe("createLoginState", () => {
  it("produces cryptographically random state and nonce", () => {
    const a = createLoginState();
    const b = createLoginState();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state.length).toBeGreaterThan(0);
  });
});

describe("buildAuthorizationUrl", () => {
  it("builds a query with the configured values and PKCE challenge", () => {
    const pkce = createPkcePair();
    const state = createLoginState();
    const url = buildAuthorizationUrl(AUTH_CONFIG, { port: 41234, pkce, state });
    expect(url).toContain("client_id=client123");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain(`code_challenge=${encodeURIComponent(pkce.challenge)}`);
    expect(url).toContain(`state=${encodeURIComponent(state.state)}`);
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A41234%2Fcallback");
    expect(url).toContain("audience=https%3A%2F%2Fapi.moeicons.com");
  });
});

describe("exchangeAuthorizationCode", () => {
  it("runtime-validates a token response", async () => {
    const token = await exchangeAuthorizationCode(
      AUTH_CONFIG,
      "code",
      "verifier",
      {
        fetchJson: async () => ({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "openid",
        }),
      },
    );
    expect(token.accessToken).toBe("at");
    expect(token.refreshToken).toBe("rt");
  });

  it("rejects a response without access_token", async () => {
    await expect(
      exchangeAuthorizationCode(AUTH_CONFIG, "code", "verifier", {
        fetchJson: async () => ({ error: "invalid_grant" }),
      }),
    ).rejects.toThrow(CliError);
  });
});

describe("hashApiKey", () => {
  it("produces a stable sha256 hex that never contains the key", () => {
    const key = "pro-super-secret-key";
    const hash = hashApiKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("secret");
  });
});

describe("requestJson", () => {
  it("maps 401 to auth error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 401 })) as unknown as typeof fetch;
    try {
      await expect(
        requestJson({ baseUrl: "https://api.example.com" }, "/x"),
      ).rejects.toThrow("unauthorized");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns typed data on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await requestJson<{ ok: boolean }>({ baseUrl: "https://api.example.com" }, "/x");
      expect(result.data.ok).toBe(true);
      expect(result.requestId).toMatch(/^req-/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("verifyApiKey", () => {
  it("trims once and validates", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ valid: true, tier: "pro", accountId: "acc-1" }), { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await verifyApiKey({ baseUrl: "https://api.example.com" }, "  pro-key  ");
      expect(result.valid).toBe(true);
      expect(result.tier).toBe("pro");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an empty key", async () => {
    await expect(
      verifyApiKey({ baseUrl: "https://api.example.com" }, "   "),
    ).rejects.toThrow(CliError);
  });
});
