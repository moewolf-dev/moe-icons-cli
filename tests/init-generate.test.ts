import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";

/**
 * CLI-12/CLI-13: config generation and React proxy generation.
 * `moeicons init` creates moeicons.config.json; `moeicons generate` writes the
 * owned proxy files into the configured output dir.
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

describe("CLI init + generate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-init-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("init creates a v1 config and never overwrites an existing one", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    const code = await main(["init", "--json"], runtime);
    expect(code).toBe(0);
    const configPath = join(dir, "moeicons.config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.schemaVersion).toBe(1);
    expect(config.framework).toBe("react");

    // second init must not overwrite
    const before = readFileSync(configPath, "utf8");
    await main(["init"], runtime);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("generate writes proxy files into the configured output dir", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    await main(["init"], runtime);
    // add icons to the config so generation has something to emit
    const configPath = join(dir, "moeicons.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.icons = ["arrow-chevron-right", "user-circle"];
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const code = await main(["generate", "--json"], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons", "registry.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "moeicons", "icons", "ArrowChevronRight.tsx"))).toBe(true);
    expect(existsSync(join(dir, "src", "moeicons", "icons", "UserCircle.tsx"))).toBe(true);
    const registry = readFileSync(join(dir, "src", "moeicons", "registry.ts"), "utf8");
    expect(registry).toContain("ArrowChevronRight");
  });

  it("generate fails cleanly when no config exists", async () => {
    const { runtime, out, setCwd } = makeRuntime();
    setCwd(dir);
    const code = await main(["generate", "--json"], runtime);
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("missing");
  });
});
