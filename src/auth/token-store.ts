import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
}

function parseSession(value: string): StoredSession | undefined {
  try {
    const session = JSON.parse(value) as Partial<StoredSession>;
    return typeof session.accountId === "string" && typeof session.accessToken === "string" &&
      typeof session.refreshToken === "string" && typeof session.expiresAt === "number" &&
      typeof session.scope === "string" && typeof session.storedAt === "number"
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
    if (!existsSync(file)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof raw === "object" && raw !== null) return raw as Record<string, StoredSession>;
    } catch {
      // corrupt store; treat as empty
    }
    return {};
  }

  function writeAll(data: Record<string, StoredSession>): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  return {
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
    clear(): void { writeAll({}); },
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
    String(run(command, args, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], ...(input ? { input } : {}) })).trim();

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
    read = () => invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${prefix}$c=$v.Retrieve('${service}','${account}');$c.RetrievePassword();[Console]::Out.Write($c.Password)`]);
    write = (value) => { invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${prefix}$p=[Console]::In.ReadToEnd();try{$v.Remove($v.Retrieve('${service}','${account}'))}catch{};$v.Add([Windows.Security.Credentials.PasswordCredential]::new('${service}','${account}',$p))`], value); };
    remove = () => { invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${prefix}try{$v.Remove($v.Retrieve('${service}','${account}'))}catch{}`]); };
  } else {
    return undefined;
  }

  const active = (): StoredSession | undefined => { try { return parseSession(read()); } catch { return undefined; } };
  return {
    get: (accountId) => { const value = active(); return value?.accountId === accountId ? value : undefined; },
    getActive: active,
    set: (session) => { write(JSON.stringify(session)); },
    delete: (accountId) => { if (active()?.accountId === accountId) { try { remove(); } catch { /* already absent */ } } },
    clear: () => { try { remove(); } catch { /* already absent */ } },
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
