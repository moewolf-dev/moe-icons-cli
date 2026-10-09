import { readFileSync, writeFileSync, mkdirSync, chmodSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { missingCredential, stateRoot } from "./session-policy.cjs";
import { withRefreshLock } from "./refresh-lock.js";
import { CliError } from "../errors/index.js";
import { execFileSync } from "node:child_process";

/**
 * TokenStore: interface with OS keychain preferred, documented fallback with
 * mode 0600. Stores refresh token + metadata; never logs tokens.
 */

export interface StoredSession {
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number; // epoch ms
  readonly scope: string;
  readonly storedAt: number;
}

export interface TokenStore {
  get(accountId: string): StoredSession | undefined;
  getActive(): StoredSession | undefined;
  set(session: StoredSession): void;
  delete(accountId: string): void;
  clear(): void;
  withRefreshLock?<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

function parseSession(value: string): StoredSession | undefined {
  try {
    const session = JSON.parse(value) as Partial<StoredSession>;
    return typeof session.accountId === "string" && typeof session.accessToken === "string" &&
      typeof session.refreshToken === "string" && typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt) &&
      typeof session.scope === "string" && typeof session.storedAt === "number" && Number.isFinite(session.storedAt)
      ? session as StoredSession : undefined;
  } catch { return undefined; }
}

/**
 * File-backed fallback store (mode 0600). Used only when no OS keychain is
 * available and the owner approves the fallback. Never logs token values.
 */
export function createFileTokenStore(options: { rootDir?: string } = {}): TokenStore {
  const root = options.rootDir ?? join(homedir(), ".moeicons");
  const file = join(root, "token-store.json");

  function readAll(): Record<string, StoredSession> {
    let meta: ReturnType<typeof lstatSync>;
    try { meta = lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new CliError("AUTH_ERROR", "file credential storage unavailable; check permissions or repair the store");
    }
    try {
      if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 1_000_000 || (process.platform !== "win32" && ((meta.mode & 0o077) !== 0 || typeof process.getuid === "function" && meta.uid !== process.getuid()))) throw new Error("insecure store");
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid store");
      for (const item of Object.values(raw)) if (!parseSession(JSON.stringify(item))) throw new Error("invalid session");
      return raw as Record<string, StoredSession>;
    } catch { throw new CliError("AUTH_ERROR", "file credential storage unavailable; check permissions or repair the store"); }
  }

  function writeAll(data: Record<string, StoredSession>): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  return {
    withRefreshLock: (operation, signal) => withRefreshLock(root, operation, signal),
    get(accountId: string): StoredSession | undefined {
      return readAll()[accountId];
    },
    getActive(): StoredSession | undefined {
      return Object.values(readAll()).sort((a, b) => b.storedAt - a.storedAt)[0];
    },
    set(session: StoredSession): void {
      const all = readAll();
      all[session.accountId] = session;
      writeAll(all);
    },
    delete(accountId: string): void {
      const all = readAll();
      delete all[accountId];
      writeAll(all);
    },
    clear(): void { readAll(); writeAll({}); },
  };
}

/** Use the native credential store when the platform provides a supported CLI. */
export function createSystemTokenStore(options: {
  platform?: NodeJS.Platform;
  execFile?: typeof execFileSync;
} = {}): TokenStore | undefined {
  const platform = options.platform ?? process.platform;
  const run = options.execFile ?? execFileSync;
  const service = "moeicons";
  const account = "active-session";
  const invoke = (command: string, args: string[], input?: string): string =>
    String(run(command, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1_000_000, stdio: ["pipe", "pipe", "pipe"], ...(input ? { input } : {}) })).trim();

  let read: () => string;
  let write: (value: string) => void;
  let remove: () => void;
  if (platform === "darwin") {
    read = () => invoke("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    write = (value) => { invoke("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value]); };
    remove = () => { invoke("security", ["delete-generic-password", "-s", service, "-a", account]); };
  } else if (platform === "linux") {
    try { invoke("secret-tool", ["--help"]); } catch { return undefined; }
    read = () => invoke("secret-tool", ["lookup", "service", service, "account", account]);
    write = (value) => { invoke("secret-tool", ["store", "--label=Moeicons CLI", "service", service, "account", account], value); };
    remove = () => { invoke("secret-tool", ["clear", "service", service, "account", account]); };
  } else if (platform === "win32") {
    const prefix = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=[Windows.Security.Credentials.PasswordVault]::new();";
    read = () => invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${prefix}try{$c=$v.Retrieve('${service}','${account}');$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{$e=$_.Exception;while($e){if($e.HResult -eq -2147023728){exit 44};$e=$e.InnerException};exit 45}`]);
    write = (value) => { invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${prefix}$p=[Console]::In.ReadToEnd();try{$v.Remove($v.Retrieve('${service}','${account}'))}catch{};$v.Add([Windows.Security.Credentials.PasswordCredential]::new('${service}','${account}',$p))`], value); };
    remove = () => { invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${prefix}try{$v.Remove($v.Retrieve('${service}','${account}'))}catch{$e=$_.Exception;while($e){if($e.HResult -eq -2147023728){exit 44};$e=$e.InnerException};exit 45}`]); };
  } else {
    return undefined;
  }

  const active = (): StoredSession | undefined => {
    try { const value = read(); if (!value) return undefined; const session = parseSession(value); if (!session) throw new Error("invalid session"); return session; }
    catch (error) { if (missingCredential(platform, error as never)) return undefined; throw new CliError("AUTH_ERROR", "system credential storage unavailable; retry or check its permissions"); }
  };
  return {
    withRefreshLock: (operation, signal) => withRefreshLock(stateRoot(process.env), operation, signal),
    get: (accountId) => { const value = active(); return value?.accountId === accountId ? value : undefined; },
    getActive: active,
    set: (session) => { try { write(JSON.stringify(session)); } catch { throw new CliError("AUTH_ERROR", "cannot save system credentials; check credential store permissions"); } },
    delete: (accountId) => { if (active()?.accountId === accountId) { try { remove(); } catch (error) { if (!missingCredential(platform, error as never)) throw new CliError("AUTH_ERROR", "cannot clear system credentials; check credential store permissions"); } } },
    clear: () => { try { remove(); } catch (error) { if (!missingCredential(platform,error as never)) throw new CliError("AUTH_ERROR", "cannot clear system credentials; check credential store permissions"); } },
  };
}

/** Redact a session for logging: never expose tokens. */
export function redactSession(session: StoredSession): {
  accountId: string;
  scope: string;
  expiresAt: number;
} {
  return {
    accountId: session.accountId,
    scope: session.scope,
    expiresAt: session.expiresAt,
  };
}
