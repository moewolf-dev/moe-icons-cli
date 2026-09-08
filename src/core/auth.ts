import { loginWithDeviceSession, refreshAuth0Session, type DeviceLoginDependencies } from "../auth/device-login.js";
import { createFileTokenStore, createSystemTokenStore, redactSession, type StoredSession, type TokenStore } from "../auth/token-store.js";
import { openBrowser } from "../auth/open-browser.js";
import { requestJson } from "../api/client.js";
import { CliError } from "../errors/index.js";
import type { CommandContext } from "./context.js";

const DEFAULT_API_BASE_URL = "https://api.moeicons.com";
const DEFAULT_WEBSITE_ORIGIN = "https://moeicons.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface AuthUseCaseDependencies {
  readonly tokenStore?: TokenStore;
  readonly systemTokenStore?: () => TokenStore | undefined;
  readonly fileTokenStore?: (rootDir?: string) => TokenStore;
  readonly request?: DeviceLoginDependencies["request"];
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly fileFallbackAllowed?: boolean;
}

export type SessionStatus =
  | { readonly kind: "authenticated"; readonly account: ReturnType<typeof redactSession> }
  | { readonly kind: "signed-out"; readonly reason?: string }
  | { readonly kind: "unknown"; readonly reason: string };

function existingStore(context: CommandContext, deps: AuthUseCaseDependencies): TokenStore | undefined {
  return deps.tokenStore ?? (context.env.MOEICONS_DISABLE_SYSTEM_KEYCHAIN === "1" ? undefined : (deps.systemTokenStore ?? createSystemTokenStore)()) ??
    (context.env.MOEICONS_TOKEN_STORE_DIR ? (deps.fileTokenStore ?? ((rootDir) => createFileTokenStore(rootDir ? { rootDir } : {})))(context.env.MOEICONS_TOKEN_STORE_DIR) : undefined);
}

/** Probe existing credentials without prompting for or creating fallback storage. */
export async function runSessionStatusUseCase(context: CommandContext, deps: AuthUseCaseDependencies = {}): Promise<SessionStatus> {
  const store = existingStore(context, deps);
  if (!store) return { kind: "signed-out" };
  const session = store.getActive();
  if (!session) return { kind: "signed-out" };
  if (session.expiresAt > context.now().getTime()) return { kind: "authenticated", account: redactSession(session) };
  const config = auth0Config(context);
  if (!config.auth0Issuer || !config.auth0ClientId) return { kind: "signed-out", reason: "stored session is expired" };
  try {
    const refreshed = await refreshAuth0Session(config, session, { fetch: deps.fetch ?? fetch, tokenStore: store, now: () => context.now().getTime(), signal: context.signal });
    return { kind: "authenticated", account: redactSession(refreshed) };
  } catch (error) {
    if (!(error instanceof CliError) || error.code === "NETWORK_ERROR" || error.code === "CANCELLED") {
      return { kind: "unknown", reason: error instanceof Error ? error.message : "session validation unavailable" };
    }
    return { kind: "signed-out", reason: error.message };
  }
}

async function selectStore(context: CommandContext, deps: AuthUseCaseDependencies): Promise<TokenStore> {
  if (deps.tokenStore) return deps.tokenStore;
  const system = context.env.MOEICONS_DISABLE_SYSTEM_KEYCHAIN === "1" ? undefined : (deps.systemTokenStore ?? createSystemTokenStore)();
  if (system) return system;
  if (context.env.MOEICONS_DISABLE_SYSTEM_KEYCHAIN === "1" && context.env.MOEICONS_TOKEN_STORE_DIR) {
    return (deps.fileTokenStore ?? ((rootDir) => createFileTokenStore(rootDir ? { rootDir } : {})))(context.env.MOEICONS_TOKEN_STORE_DIR);
  }
  if (deps.fileFallbackAllowed === false) throw new CliError("AUTH_ERROR", "system credential storage is unavailable; non-interactive file fallback is disabled");
  if (!context.ui.confirm) throw new CliError("AUTH_ERROR", "system credential storage is unavailable");
  const accepted = await context.ui.confirm("System credential storage is unavailable. Use a local file protected with mode 0600?", context.signal);
  if (accepted === undefined) throw new CliError("CANCELLED", "login cancelled");
  if (!accepted) throw new CliError("AUTH_ERROR", "login requires secure credential storage");
  return (deps.fileTokenStore ?? ((rootDir) => createFileTokenStore(rootDir ? { rootDir } : {})))(context.env.MOEICONS_TOKEN_STORE_DIR);
}

function assertTrustedHttpBase(value: string, envName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError("VALIDATION_ERROR", `${envName} is not a valid URL`);
  }
  const loopback = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new CliError("VALIDATION_ERROR", `${envName} must be https or loopback http`);
  }
  return value.replace(/\/$/, "");
}

function isLoopbackHttp(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export type MoeiconsEnvironment = "production" | "local";

export interface AuthEnvironment {
  readonly mode: MoeiconsEnvironment;
  readonly label: string;
  readonly apiBaseUrl: string;
  readonly websiteOrigin: string;
  readonly auth0Issuer: string;
  readonly auth0ClientId: string;
}

/**
 * H5: resolve a single coherent auth environment. `MOEICONS_ENV` may declare
 * `local` or `production`; when set it must agree with the endpoints. Loopback
 * HTTP is only allowed for local, and the API/website must not be mixed across
 * environments so a dev token can never be written to production (or vice versa).
 */
export function resolveAuthEnvironment(
  env: Record<string, string | undefined>,
): AuthEnvironment {
  const apiBaseUrl = assertTrustedHttpBase(
    env.MOEICONS_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    "MOEICONS_API_BASE_URL",
  );
  const websiteOrigin = assertTrustedHttpBase(
    env.MOEICONS_WEBSITE_ORIGIN ?? DEFAULT_WEBSITE_ORIGIN,
    "MOEICONS_WEBSITE_ORIGIN",
  );
  const apiLoopback = isLoopbackHttp(apiBaseUrl);
  const websiteLoopback = isLoopbackHttp(websiteOrigin);
  if (apiLoopback !== websiteLoopback) {
    throw new CliError(
      "VALIDATION_ERROR",
      "MOEICONS_API_BASE_URL and MOEICONS_WEBSITE_ORIGIN must both be loopback (local) or both be non-loopback (production)",
    );
  }
  const declared = env.MOEICONS_ENV;
  if (declared !== undefined && declared !== "local" && declared !== "production") {
    throw new CliError("VALIDATION_ERROR", "MOEICONS_ENV must be local or production");
  }
  const inferred: MoeiconsEnvironment = apiLoopback ? "local" : "production";
  if (declared && declared !== inferred) {
    throw new CliError(
      "VALIDATION_ERROR",
      `MOEICONS_ENV=${declared} conflicts with configured endpoints (${inferred})`,
    );
  }
  const mode = declared ?? inferred;
  return {
    mode,
    label: mode === "local" ? "local (dev)" : "production",
    apiBaseUrl,
    websiteOrigin,
    auth0Issuer: env.MOEICONS_AUTH0_ISSUER ?? "",
    auth0ClientId: env.MOEICONS_AUTH0_CLIENT_ID ?? "",
  };
}

function auth0Config(context: CommandContext) {
  const resolved = resolveAuthEnvironment(context.env);
  return {
    apiBaseUrl: resolved.apiBaseUrl,
    websiteOrigin: resolved.websiteOrigin,
    auth0Issuer: resolved.auth0Issuer,
    auth0ClientId: resolved.auth0ClientId,
  };
}

/** H5: human-readable environment label for `login`/`account` output. */
export function describeAuthEnvironment(context: CommandContext): string {
  return resolveAuthEnvironment(context.env).label;
}

export async function runLoginUseCase(context: CommandContext, deps: AuthUseCaseDependencies = {}): Promise<ReturnType<typeof redactSession>> {
  const tokenStore = await selectStore(context, deps);
  const apiBaseUrl = auth0Config(context).apiBaseUrl;
  const request =
    deps.request ??
    ((path, options) =>
      requestJson({ baseUrl: apiBaseUrl }, path, {
        ...options,
        retries: options.method === "GET" || options.method === "DELETE" ? 3 : 0,
        ...(options.stage ? { stage: `login ${options.stage}` } : {}),
      }));
  // H4 test seam: loopback acceptance runs headless. Production never sets this.
  const browserOpener =
    deps.openBrowser ??
    (context.env.MOEICONS_NO_BROWSER === "1" ? () => Promise.resolve() : openBrowser);
  const session = await loginWithDeviceSession(auth0Config(context), {
    request,
    openBrowser: browserOpener,
    sleep: deps.sleep ?? ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new CliError("CANCELLED", "login cancelled")); }, { once: true });
    })),
    tokenStore,
    now: () => context.now().getTime(),
  }, context.signal);
  return redactSession(session);
}

async function activeSession(context: CommandContext, deps: AuthUseCaseDependencies): Promise<{ store: TokenStore; session: StoredSession }> {
  const store = await selectStore(context, deps);
  const session = store.getActive();
  if (!session) throw new CliError("AUTH_ERROR", "not logged in");
  if (session.expiresAt > context.now().getTime()) return { store, session };
  const config = auth0Config(context);
  if (!config.auth0Issuer || !config.auth0ClientId) throw new CliError("AUTH_ERROR", "session expired and Auth0 refresh configuration is unavailable");
  const refreshed = await refreshAuth0Session(config, session, { fetch: deps.fetch ?? fetch, tokenStore: store, now: () => context.now().getTime(), signal: context.signal });
  return { store, session: refreshed };
}

/** Internal authenticated transport credential; adapters must never render it. */
export async function runAccessTokenUseCase(context: CommandContext, deps: AuthUseCaseDependencies = {}, forceRefresh = false): Promise<string> {
  if (!forceRefresh) return (await activeSession(context, deps)).session.accessToken;
  const store = await selectStore(context, deps);
  const session = store.getActive();
  if (!session) throw new CliError("AUTH_ERROR", "not logged in");
  const config = auth0Config(context);
  if (!config.auth0Issuer || !config.auth0ClientId) throw new CliError("AUTH_ERROR", "Auth0 refresh configuration is unavailable");
  return (await refreshAuth0Session(config, session, { fetch: deps.fetch ?? fetch, tokenStore: store, now: () => context.now().getTime(), signal: context.signal })).accessToken;
}

export async function runAccountUseCase(context: CommandContext, deps: AuthUseCaseDependencies = {}): Promise<ReturnType<typeof redactSession>> {
  return redactSession((await activeSession(context, deps)).session);
}

/** Remote Worker entitlement lookup (H2); never guesses a plan from scope. */
export async function runRemoteAccountUseCase(
  context: CommandContext,
  deps: AuthUseCaseDependencies = {},
): Promise<{ tier: string; entitlementStatus: string; validUntil: string | null } | undefined> {
  const apiBaseUrl = auth0Config(context).apiBaseUrl;
  const doFetch = deps.fetch ?? fetch;
  let session: StoredSession;
  try {
    session = (await activeSession(context, deps)).session;
  } catch {
    throw new CliError("AUTH_ERROR", "not logged in");
  }

  const call = async (token: string): Promise<Response> =>
    doFetch(`${apiBaseUrl}/v1/cli/account`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: context.signal,
    });
  let response = await call(session.accessToken);
  // 401 => refresh exactly once and retry (H2 point 6).
  if (response.status === 401) {
    const refreshed = await runAccessTokenUseCase(context, deps, true);
    response = await call(refreshed);
  }
  if (response.status === 403) {
    // no/expired entitlement: caller still has a valid account; report free.
    return { tier: "free", entitlementStatus: "none", validUntil: null };
  }
  if (!response.ok) {
    throw new CliError("NETWORK_ERROR", `account lookup failed with ${response.status}`);
  }
  const value = (await response.json()) as Record<string, unknown>;
  if (
    typeof value.tier !== "string" ||
    typeof value.entitlementStatus !== "string" ||
    (value.validUntil !== null && typeof value.validUntil !== "string")
  ) {
    throw new CliError("VALIDATION_ERROR", "invalid account response");
  }
  return { tier: value.tier, entitlementStatus: value.entitlementStatus, validUntil: value.validUntil ?? null };
}

export async function runLogoutUseCase(context: CommandContext, deps: AuthUseCaseDependencies = {}): Promise<{ revoked: boolean }> {
  const store = existingStore(context, deps);
  if (!store) return { revoked: true };
  const session = store.getActive();
  if (!session) return { revoked: true };
  let revoked = false;
  const config = auth0Config(context);
  if (config.auth0Issuer && config.auth0ClientId) {
    try {
      const response = await (deps.fetch ?? fetch)(`${config.auth0Issuer.replace(/\/$/, "")}/oauth/revoke`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: config.auth0ClientId, token: session.refreshToken }), signal: context.signal,
      });
      revoked = response.ok;
    } catch { revoked = false; }
  }
  store.clear();
  return { revoked };
}
