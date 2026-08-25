import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTokenStore, createSystemTokenStore, type StoredSession } from "../src/auth/token-store.js";

const SESSION: StoredSession = {
  accountId: "auth0|user", accessToken: "access", refreshToken: "refresh",
  expiresAt: 123, scope: "openid", storedAt: 100,
};

describe("credential stores", () => {
  it("writes the explicitly approved fallback with mode 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "moeicons-token-"));
    try {
      const store = createFileTokenStore({ rootDir: root });
      store.set(SESSION);
      expect(store.getActive()).toEqual(SESSION);
      expect(statSync(join(root, "token-store.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, "token-store.json"), "utf8")).toContain("refresh");
      store.clear();
      expect(store.getActive()).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses macOS Keychain commands without a shell", () => {
    let stored = "";
    const execFile = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security");
      if (args[0] === "find-generic-password") return stored;
      if (args[0] === "add-generic-password") { stored = args.at(-1) ?? ""; return ""; }
      if (args[0] === "delete-generic-password") { stored = ""; return ""; }
      return "";
    });
    const store = createSystemTokenStore({ platform: "darwin", execFile: execFile as never });
    expect(store).toBeDefined();
    store?.set(SESSION);
    expect(store?.getActive()).toEqual(SESSION);
    store?.clear();
    expect(store?.getActive()).toBeUndefined();
    expect(execFile.mock.calls.every((call) => call[0] === "security")).toBe(true);
  });

  it("uses Windows PasswordVault and sends the credential through stdin", () => {
    let stored = "";
    const execFile = vi.fn((_command: string, args: readonly string[], options: { input?: string }) => {
      const script = args.at(-1) ?? "";
      if (options.input) stored = options.input;
      if (script.includes("[Console]::Out.Write")) return stored;
      if (script.includes("$v.Remove") && !options.input) stored = "";
      return "";
    });
    const store = createSystemTokenStore({ platform: "win32", execFile: execFile as never });
    store?.set(SESSION);
    expect(store?.getActive()).toEqual(SESSION);
    expect(execFile.mock.calls.some((call) => JSON.stringify(call[1]).includes("refresh"))).toBe(false);
  });
});
