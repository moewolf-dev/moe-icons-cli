import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";

/**
 * CLI-04: wizard TUI with injected streams. Selection, confirmation, and the
 * free-install path execute against a fake TTY; cancellation exits 0.
 */

function makeTtyRuntime(lines: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let cwd = "";
  let lineIdx = 0;
  return {
    runtime: {
      cwd: () => cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => true,
      readLine: async () => lines[lineIdx++] ?? "",
      readKey: async () => "",
    },
    out,
    err,
    setCwd: (d: string) => {
      cwd = d;
    },
  };
}

describe("wizard TUI (CLI-04)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-tui-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("selects free install, confirms root, and writes the managed output", async () => {
    const { runtime, out, setCwd } = makeTtyRuntime(["1", "y"]);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(0);
    expect(out.join("")).toContain("Install moeicons free");
    expect(existsSync(join(dir, "src", "moeicons", ".moeicons-free.marker"))).toBe(true);
  });

  it("exits 0 when the user cancels at the menu", async () => {
    const { runtime, setCwd } = makeTtyRuntime(["0"]);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
  });

  it("exits 0 when the user declines the project-root confirmation", async () => {
    const { runtime, setCwd } = makeTtyRuntime(["1", "n"]);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
  });
});
