import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  set(session: StoredSession): void;
  delete(accountId: string): void;
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
