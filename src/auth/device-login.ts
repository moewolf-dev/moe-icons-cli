import { createLoginState, createPkcePair } from "./pkce.js";
import {
  parseCreateLoginResponse,
  parseExchangeLoginResponse,
  parsePollLoginResponse,
} from "./login-schemas.js";
import type { StoredSession, TokenStore } from "./token-store.js";
import { CliError } from "../errors/index.js";

export interface DeviceLoginConfig {
  readonly apiBaseUrl: string;
  readonly websiteOrigin: string;
  readonly auth0Issuer: string;
  readonly auth0ClientId: string;
}

export type LoginRequestStage = "create" | "poll" | "exchange" | "cleanup";

export interface DeviceLoginRequestOptions {
  readonly method: "GET" | "POST" | "DELETE";
  readonly auth?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly stage?: LoginRequestStage;
}

export interface DeviceLoginDependencies {
  readonly request: <T>(
    path: string,
    options: DeviceLoginRequestOptions,
  ) => Promise<{ status: number; data: T }>;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly tokenStore: TokenStore;
  readonly now: () => number;
}

function assertBrowserUrl(value: string, expectedOrigin: string): void {
  const url = new URL(value);
  if (url.origin !== new URL(expectedOrigin).origin || url.pathname !== "/cli-login") {
    throw new CliError("AUTH_ERROR", "backend returned an untrusted login URL");
  }
}

export async function loginWithDeviceSession(
  config: DeviceLoginConfig,
  deps: DeviceLoginDependencies,
  signal?: AbortSignal,
): Promise<StoredSession> {
  const pkce = createPkcePair();
  const state = createLoginState();
  const createdRaw = await deps.request<unknown>("/v1/cli-login-sessions", {
    method: "POST",
    body: { codeChallenge: pkce.challenge, clientNonce: state.nonce, state: state.state },
    stage: "create",
    ...(signal ? { signal } : {}),
  });
  const created = parseCreateLoginResponse(createdRaw.data);
  assertBrowserUrl(created.browserUrl, config.websiteOrigin);
  await deps.openBrowser(created.browserUrl);
  const auth = `Bearer ${created.pollingToken}`;
  const sessionPath = `/v1/cli-login-sessions/${encodeURIComponent(created.loginId)}`;
  try {
    while (deps.now() < Date.parse(created.expiresAt)) {
      if (signal?.aborted) throw new CliError("CANCELLED", "login cancelled");
      const polledRaw = await deps.request<unknown>(sessionPath, {
        method: "GET",
        auth,
        stage: "poll",
        ...(signal ? { signal } : {}),
      });
      const polled = parsePollLoginResponse(polledRaw.data);
      if (polledRaw.status === 200 && polled.status === "complete" && polled.exchangeCode) {
        const exchangedRaw = await deps.request<unknown>(`${sessionPath}/exchange`, {
          method: "POST",
          auth,
          stage: "exchange",
          body: {
            exchangeCode: polled.exchangeCode,
            clientNonce: state.nonce,
            codeVerifier: pkce.verifier,
          },
          ...(signal ? { signal } : {}),
        });
        const exchanged = parseExchangeLoginResponse(exchangedRaw.data);
        const stored: StoredSession = {
          accountId: exchanged.accountId,
          accessToken: exchanged.accessToken,
          refreshToken: exchanged.refreshToken,
          expiresAt: deps.now() + exchanged.expiresIn * 1000,
          scope: "openid profile email offline_access",
          storedAt: deps.now(),
        };
        deps.tokenStore.set(stored);
        return stored;
      }
      await deps.sleep(created.intervalSeconds * 1000, signal);
    }
    throw new CliError("AUTH_ERROR", "login session expired");
  } catch (error) {
    try {
      await deps.request(sessionPath, { method: "DELETE", auth, stage: "cleanup" });
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export async function refreshAuth0Session(
  config: DeviceLoginConfig,
  session: StoredSession,
  deps: { fetch: typeof fetch; tokenStore: TokenStore; now: () => number; signal?: AbortSignal },
): Promise<StoredSession> {
  const response = await deps.fetch(`${config.auth0Issuer.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: config.auth0ClientId,
      refresh_token: session.refreshToken,
    }),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    throw new CliError("AUTH_ERROR", "Auth0 refresh failed");
  }
  const updated: StoredSession = {
    ...session,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : session.refreshToken,
    expiresAt: deps.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
    storedAt: deps.now(),
  };
  deps.tokenStore.set(updated);
  return updated;
}
