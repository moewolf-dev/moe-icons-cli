import { loginWithDeviceSession, refreshAuth0Session, type DeviceLoginDependencies } from "../auth/device-login.js";
import { createFileTokenStore, createSystemTokenStore, redactSession, type StoredSession, type TokenStore } from "../auth/token-store.js";
import { openBrowser } from "../auth/open-browser.js";
import { requestJson } from "../api/client.js";
import { CliError } from "../errors/index.js";
import type { CommandContext } from "./context.js";

const API_BASE_URL = "https://api.moeicons.com";
const WEBSITE_ORIGIN = "https://moeicons.com";

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

function auth0Config(context: CommandContext) {
  return {
    apiBaseUrl: API_BASE_URL,
    websiteOrigin: WEBSITE_ORIGIN,
    auth0Issuer: context.env.MOEICONS_AUTH0_ISSUER ?? "",
    auth0ClientId: context.env.MOEICONS_AUTH0_CLIENT_ID ?? "",
  };
}

export async function runLoginUseCase(context: CommandContext, deps: AuthUseCaseDependencies = {}): Promise<ReturnType<typeof redactSession>> {
  const tokenStore = await selectStore(context, deps);
  const request = deps.request ?? ((path, options) => requestJson({ baseUrl: API_BASE_URL }, path, { ...options, retries: options.method === "GET" ? 3 : 0 }));
  const session = await loginWithDeviceSession(auth0Config(context), {
    request,
    openBrowser: deps.openBrowser ?? openBrowser,
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
