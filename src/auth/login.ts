import { createHash } from "node:crypto";
import { startLoopbackCallbackServer, type ActiveCallbackServer } from "./callback.js";
import { createPkcePair, createLoginState, type PkcePair, type LoginState } from "./pkce.js";
import { CliError } from "../errors/index.js";

/**
 * OAuth 2.0 Authorization Code + PKCE login flow. Never accepts issuer from the
 * callback; validates state; exchanges code; stores token only after all
 * checks; closes the callback server in finally.
 */

export interface AuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly audience: string;
  readonly redirectPath: string; // e.g. /callback
  readonly scope: string;
}

/** Build the authorization URL from configured values; never from the callback. */
export function buildAuthorizationUrl(
  config: AuthConfig,
  attempt: { port: number; pkce: PkcePair; state: LoginState },
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: `http://127.0.0.1:${attempt.port}${config.redirectPath}`,
    scope: config.scope,
    audience: config.audience,
    code_challenge: attempt.pkce.challenge,
    code_challenge_method: "S256",
    state: attempt.state.state,
    nonce: attempt.state.nonce,
  });
  return `${config.issuer.replace(/\/$/, "")}/authorize?${params.toString()}`;
}

export interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string;
}

/** POST the authorization code and runtime-validate the token response. */
export async function exchangeAuthorizationCode(
  config: AuthConfig,
  code: string,
  verifier: string,
  deps: { fetchJson: (url: string, body: unknown) => Promise<unknown> },
): Promise<TokenResponse> {
  const raw = await deps.fetchJson(`${config.issuer.replace(/\/$/, "")}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: "",
    code_verifier: verifier,
  });
  if (typeof raw !== "object" || raw === null) {
    throw new CliError("AUTH_ERROR", "invalid token response");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token.length === 0) {
    throw new CliError("AUTH_ERROR", "token response missing access_token");
  }
  return {
    accessToken: record.access_token,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : "",
    expiresIn: typeof record.expires_in === "number" ? record.expires_in : 3600,
    scope: typeof record.scope === "string" ? record.scope : "",
  };
}

export interface LoginDeps {
  readonly openBrowser: (url: string) => Promise<void>;
  readonly fetchJson: (url: string, body: unknown) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

/**
 * Start the callback server before opening the browser; validate state then
 * exchange; store token only after all checks; close server in finally.
 */
export async function loginWithBrowser(
  config: AuthConfig,
  deps: LoginDeps,
): Promise<TokenResponse> {
  const active: ActiveCallbackServer = startLoopbackCallbackServer({
    host: "127.0.0.1",
    port: 0,
    path: config.redirectPath,
    timeoutMs: 120_000,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  try {
    const pkce = createPkcePair();
    const loginState = createLoginState();
    const url = buildAuthorizationUrl(config, { port: active.port, pkce, state: loginState });

    let browserOpened = false;
    try {
      await deps.openBrowser(url);
      browserOpened = true;
    } catch {
      // browser-open failure is surfaced below regardless of browserOpened
      throw new CliError("AUTH_ERROR", "failed to open the browser; please open the URL manually");
    }
    void browserOpened;

    const callback = await active.outcome;
    if (!callback.ok) {
      throw new CliError(
        callback.code === "TIMEOUT" ? "NETWORK_ERROR" : "AUTH_ERROR",
        callback.message,
      );
    }
    if (callback.value.state !== loginState.state) {
      throw new CliError("AUTH_ERROR", "state mismatch in callback; possible CSRF");
    }

    return await exchangeAuthorizationCode(config, callback.value.code, pkce.verifier, deps);
  } finally {
    active.stop();
  }
}

/** SHA-256 hex of an API key for redaction/audit (never store the raw key). */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
