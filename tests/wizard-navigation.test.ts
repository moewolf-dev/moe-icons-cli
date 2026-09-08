import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { CliError } from "../src/errors/index.js";
import type { AuthUseCaseDependencies } from "../src/core/auth.js";

function makeRuntime(lines: string[], auth?: AuthUseCaseDependencies) {
  const out: string[] = [];
  const err: string[] = [];
  let lineIdx = 0;
  let cwd = "";
  return {
    runtime: {
      cwd: () => cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => true,
      columns: () => 80,
      readLine: async () => lines[lineIdx++] ?? "0",
      readKey: async () => "",
      fetchVersions: async () => [],
      ...(auth ? { auth } : {}),
    },
    out,
    err,
    setCwd: (value: string) => {
      cwd = value;
    },
  };
}

describe("wizard navigation and login recovery (P4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-p4-nav-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives fifty Home → Settings → Back round trips without repeating the wordmark", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      lines.push("5", "2"); // Settings, Back
    }
    lines.push("6"); // Exit
    const { runtime, out, setCwd } = makeRuntime(lines);
    setCwd(dir);
    expect(await main([], runtime)).toBe(0);
    const text = out.join("");
    const wordmarkHits = text.split("___ ____ ___").length - 1;
    expect(wordmarkHits).toBe(1);
    expect(text).toContain("Exited");
  });

  it("keeps login failures inside recovery and returns home on Back", async () => {
    let attempts = 0;
    const auth: AuthUseCaseDependencies = {
      request: async () => {
        attempts += 1;
        throw new CliError(
          "VALIDATION_ERROR",
          "login create: response is not valid JSON (HTTP 404, content-type=text/plain, body=text/plain, 9 bytes)",
        );
      },
      openBrowser: async () => undefined,
      sleep: async () => undefined,
      tokenStore: {
        get: () => undefined,
        getActive: () => undefined,
        set: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
      },
      fileFallbackAllowed: true,
    };
    // Login (4) → fail → Back (2 on recovery) → Exit (6)
    const { runtime, out, err, setCwd } = makeRuntime(["4", "2", "6"], auth);
    setCwd(dir);
    expect(await main([], runtime)).toBe(0);
    expect(attempts).toBe(1);
    expect(err.join("")).toContain("Login failed:");
    expect(err.join("")).toContain("not valid JSON");
    expect(err.join("")).not.toContain("error: ");
    expect(out.join("")).toContain("Retry login");
    expect(out.join("")).toContain("Exited");
  });

  it("retries login with a fresh attempt before returning home", async () => {
    let attempts = 0;
    const auth: AuthUseCaseDependencies = {
      request: async () => {
        attempts += 1;
        throw new CliError("NETWORK_ERROR", "login create: network error (offline)");
      },
      openBrowser: async () => undefined,
      sleep: async () => undefined,
      tokenStore: {
        get: () => undefined,
        getActive: () => undefined,
        set: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
      },
      fileFallbackAllowed: true,
    };
    // Login → fail → Retry → fail → Back → Exit
    const { runtime, setCwd } = makeRuntime(["4", "1", "2", "6"], auth);
    setCwd(dir);
    expect(await main([], runtime)).toBe(0);
    expect(attempts).toBe(2);
  });

  it("exits login recovery on cancel without a second Cancelled line from orchestrator", async () => {
    const auth: AuthUseCaseDependencies = {
      request: async () => {
        throw new CliError("NETWORK_ERROR", "login create: network error (offline)");
      },
      openBrowser: async () => undefined,
      sleep: async () => undefined,
      tokenStore: {
        get: () => undefined,
        getActive: () => undefined,
        set: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
      },
      fileFallbackAllowed: true,
    };
    // Login → fail → Cancel (0) — stream adapter has no cancel frame; orchestrator must not invent one.
    const { runtime, err, setCwd } = makeRuntime(["4", "0"], auth);
    setCwd(dir);
    expect(await main([], runtime)).toBe(0);
    expect(err.join("")).toContain("Login failed:");
    expect(err.join("")).not.toMatch(/Cancelled/);
  });
});
