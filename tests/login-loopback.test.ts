import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { loginWithDeviceSession } from "../src/auth/device-login.js";
import { requestJson } from "../src/api/client.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";

function memoryStore() {
  let value: StoredSession | undefined;
  const store: TokenStore = {
    get: () => value,
    getActive: () => value,
    set: (next) => {
      value = next;
    },
    delete: () => {
      value = undefined;
    },
    clear: () => {
      value = undefined;
    },
  };
  return { store, get: () => value };
}

/** Loopback fake API covering create → poll → exchange (+ optional fail/retry). */
async function withFakeLoginApi(
  handler: (request: {
    method: string;
    url: string;
    body: unknown;
  }) => { status: number; body: unknown; contentType?: string } | undefined,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const result = handler({ method: req.method ?? "GET", url: req.url ?? "/", body });
    if (!result) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }
    res.writeHead(result.status, {
      "content-type": result.contentType ?? "application/json",
    });
    res.end(
      typeof result.body === "string" ? result.body : JSON.stringify(result.body),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("login loopback E2E (P4-D10)", () => {
  it("completes create → pending → complete → exchange against loopback HTTP", async () => {
    const memory = memoryStore();
    let polls = 0;
    await withFakeLoginApi((req) => {
      if (req.method === "POST" && req.url === "/v1/cli-login-sessions") {
        return {
          status: 201,
          body: {
            loginId: "login-1",
            pollingToken: "poll-token",
            browserUrl: "https://moeicons.com/cli-login?loginId=login-1",
            intervalSeconds: 1,
            expiresAt: "2099-01-01T00:00:00Z",
          },
        };
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/cli-login-sessions/login-1")) {
        polls += 1;
        if (polls === 1) return { status: 202, body: { status: "pending" } };
        return { status: 200, body: { status: "complete", exchangeCode: "ex-1" } };
      }
      if (req.method === "POST" && req.url === "/v1/cli-login-sessions/login-1/exchange") {
        return {
          status: 200,
          body: {
            accountId: "auth0|loopback",
            accessToken: "access",
            refreshToken: "refresh",
            expiresIn: 3600,
            tokenType: "Bearer",
          },
        };
      }
      return undefined;
    }, async (baseUrl) => {
      const opened: string[] = [];
      const session = await loginWithDeviceSession(
        {
          apiBaseUrl: baseUrl,
          websiteOrigin: "https://moeicons.com",
          auth0Issuer: "https://tenant.auth0.com",
          auth0ClientId: "client",
        },
        {
          request: (path, options) =>
            requestJson({ baseUrl }, path, {
              ...options,
              retries: 0,
              ...(options.stage ? { stage: `login ${options.stage}` } : {}),
            }),
          openBrowser: async (url) => {
            opened.push(url);
          },
          sleep: async () => undefined,
          tokenStore: memory.store,
          now: () => Date.parse("2026-09-07T00:00:00Z"),
        },
      );
      expect(opened).toEqual(["https://moeicons.com/cli-login?loginId=login-1"]);
      expect(session.accountId).toBe("auth0|loopback");
      expect(memory.get()?.accessToken).toBe("access");
      expect(polls).toBe(2);
    });
  });

  it("surfaces HTML create failures as typed diagnostics without secrets", async () => {
    await withFakeLoginApi((req) => {
      if (req.method === "POST" && req.url === "/v1/cli-login-sessions") {
        return {
          status: 404,
          contentType: "text/html",
          body: "<html>missing route</html>",
        };
      }
      return undefined;
    }, async (baseUrl) => {
      await expect(
        requestJson({ baseUrl }, "/v1/cli-login-sessions", {
          method: "POST",
          stage: "login create",
          body: { codeChallenge: "x", clientNonce: "n", state: "s" },
        }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: expect.stringMatching(/login create:.*not valid JSON.*html/i),
      });
    });
  });
});
