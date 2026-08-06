import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";

/**
 * E2E-03: free CLI disposable-project flow. Global/local invocation, confirmed
 * root, config generation, and idempotent reinstall.
 */

function makeRuntime() {
  const out: string[] = [];
  const err: string[] = [];
  let cwd = "";
  return {
    runtime: {
      cwd: () => cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => false,
      readLine: async () => "",
      readKey: async () => "",
    },
    out,
    err,
    setCwd: (d: string) => {
      cwd = d;
    },
  };
}

describe("E2E-03 free CLI flow", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-free-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects the project root and reports the free install plan", async () => {
    const { runtime, out, setCwd } = makeRuntime();
    setCwd(dir);
    const code = await main(["install", "free", "--json"], runtime);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      projectRoot: string;
      group: string;
      ok: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.projectRoot).toBe(dir);
    expect(parsed.group).toBe("free");
  });

  it("creates the moeicons managed output on install", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    await main(["install", "--json"], runtime);
    // install writes the managed marker + types into src/moeicons
    expect(existsSync(join(dir, "src", "moeicons", ".moeicons-free.marker"))).toBe(true);
    expect(existsSync(join(dir, "src", "moeicons", "types.ts"))).toBe(true);
  });

  it("reruns idempotently without corrupting prior output", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    await main(["install", "--json"], runtime);
    const firstMarker = readFileSync(join(dir, "src", "moeicons", ".moeicons-free.marker"), "utf8");
    await main(["install", "--json"], runtime);
    const secondMarker = readFileSync(join(dir, "src", "moeicons", ".moeicons-free.marker"), "utf8");
    expect(secondMarker).toBe(firstMarker);
  });

  it("fails cleanly outside a project (no package.json)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "e2e-noproj-"));
    try {
      const { runtime, err, setCwd } = makeRuntime();
      setCwd(outside);
      const code = await main(["install", "--json"], runtime);
      expect(code).toBe(1);
      expect(err.join("")).toContain("no package.json");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
