import { describe, it, expect, vi } from "vitest";
import { createPkcePair, createLoginState } from "../src/auth/pkce.js";
import { buildAuthorizationUrl, hashApiKey, exchangeAuthorizationCode } from "../src/auth/login.js";
import { requestJson, verifyApiKey, redactJsonForPreview } from "../src/api/client.js";
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
      ).rejects.toThrow(/unauthorized/);
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

  it("diagnoses HTML and plain-text non-JSON bodies with stage context", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>Not Found</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      await expect(
        requestJson({ baseUrl: "https://api.example.com" }, "/v1/cli-login-sessions", {
          method: "POST",
          stage: "login create",
        }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: expect.stringMatching(/login create:.*not valid JSON.*text\/html.*body=html, \d+ bytes/i),
      });
      await expect(
        requestJson({ baseUrl: "https://api.example.com" }, "/v1/cli-login-sessions", {
          method: "POST",
          stage: "login create",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return !message.includes("<html") && !message.includes("Not Found");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never includes secret values in default error summaries", async () => {
    const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: secret, email: "user@example.com" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      await expect(requestJson({ baseUrl: "https://api.example.com" }, "/x", { method: "POST" })).rejects.toSatisfy(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toMatch(/body=json-declared, \d+ bytes/);
          expect(message).not.toContain("preview=");
          expect(message).not.toContain(secret);
          expect(message).not.toContain("user@example.com");
          expect(message).not.toContain("access_token");
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("redacts nested secrets when debug body preview is explicitly enabled", async () => {
    const secret = "actual-secret-value-do-not-leak";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ nested: { access_token: secret }, ok: true }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      await expect(
        requestJson({ baseUrl: "https://api.example.com" }, "/x", { debugBodyPreview: true }),
      ).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("preview=");
        expect(message).toContain("[redacted]");
        expect(message).not.toContain(secret);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries idempotent GET network failures with backoff and never retries POST", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    let getCalls = 0;
    let postCalls = 0;
    try {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/get")) {
          getCalls += 1;
          if (getCalls < 3) throw new TypeError("fetch failed");
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        postCalls += 1;
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;

      const getPromise = requestJson({ baseUrl: "https://api.example.com" }, "/get", {
        method: "GET",
        retries: 3,
      });
      await vi.runAllTimersAsync();
      await expect(getPromise).resolves.toMatchObject({ data: { ok: true } });
      expect(getCalls).toBe(3);

      const postPromise = requestJson({ baseUrl: "https://api.example.com" }, "/post", {
        method: "POST",
        retries: 3,
      });
      await expect(postPromise).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(postCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("does not retry after an external abort", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const controller = new AbortController();
      globalThis.fetch = (async () => {
      calls += 1;
      controller.abort();
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    try {
      await expect(
        requestJson({ baseUrl: "https://api.example.com" }, "/x", {
          method: "GET",
          retries: 3,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR", message: expect.stringMatching(/aborted/i) });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("diagnoses empty error bodies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("", { status: 500, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    try {
      await expect(requestJson({ baseUrl: "https://api.example.com" }, "/x")).rejects.toMatchObject({
        message: expect.stringMatching(/empty error response/),
      });
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
