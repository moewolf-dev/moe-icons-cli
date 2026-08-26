import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";

/**
 * CLI-04: wizard TUI with injected streams. Selection, confirmation, and the
 * free-install path execute against a fake TTY; cancellation exits 0.
 */

function makeTtyRuntime(lines: string[], env: Record<string, string | undefined> = {}, fetchVersions: () => Promise<readonly string[]> = async () => []) {
  const out: string[] = [];
  const err: string[] = [];
  let cwd = "";
  let lineIdx = 0;
  let tty = true;
  return {
    runtime: {
      cwd: () => cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env,
      isTTY: () => tty,
      readLine: async () => lines[lineIdx++] ?? "",
      readKey: async () => "",
      fetchVersions,
    },
    out,
    err,
    setCwd: (d: string) => {
      cwd = d;
    },
    setTty: (value: boolean) => {
      tty = value;
    },
  };
}

describe("wizard TUI (CLI-04)", () => {
  let dir: string;
  let releaseDir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-tui-"));
    releaseDir = mkdtempSync(join(tmpdir(), "cli-tui-release-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFreeReleaseFixture(releaseDir);
    env = {
      MOEICONS_FREE_RELEASE_DIR: releaseDir,
      MOEICONS_CACHE_DIR: join(dir, ".moeicons-cache"),
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(releaseDir, { recursive: true, force: true });
  });

  it("selects free install, picks react, confirms root, and writes the managed output", async () => {
    const { runtime, out, setCwd } = makeTtyRuntime(["2", "1", "y"], env);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(0);
    expect(out.join("")).toContain("Install moeicons free");
    expect(out.join("")).toContain("Choose an output target");
    expect(existsSync(join(dir, "src", "moeicons", ".moeicons-free.marker"))).toBe(true);
    expect(existsSync(join(dir, ".moeicons", "install-metadata.json"))).toBe(true);
  });

  it("exits 0 with zero writes when the user cancels the target selection", async () => {
    const { runtime, setCwd } = makeTtyRuntime(["2", "0"], env);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
    expect(existsSync(join(dir, ".moeicons"))).toBe(false);
  });

  it("shows a nonblocking update notice when the registry is unavailable", async () => {
    const { runtime, out, setCwd } = makeTtyRuntime(["0"], env, async () => {
      throw new Error("offline");
    });
    setCwd(dir);
    expect(await main([], runtime)).toBe(0);
    expect(out.join("")).toContain("Current 0.0.1 / Latest unavailable / Update: unavailable");
  });

  it("exits 0 when the user cancels at the menu", async () => {
    const { runtime, setCwd } = makeTtyRuntime(["0"], env);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
  });

  it("exits 0 when the user declines the project-root confirmation", async () => {
    const { runtime, setCwd } = makeTtyRuntime(["2", "1", "n"], env);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
  });

  it("skips the project-root confirmation when --yes is set", async () => {
    const { runtime, setCwd } = makeTtyRuntime(["2", "1"], env);
    setCwd(dir);
    const code = await main(["--yes"], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons", ".moeicons-free.marker"))).toBe(true);
  });

  it("does not write files from a non-TTY wizard without --yes", async () => {
    const { runtime, out, err, setCwd, setTty } = makeTtyRuntime([], env);
    setTty(false);
    setCwd(dir);
    const code = await main([], runtime);
    expect(code).toBe(1);
    expect(err.join("")).toContain("TTY");
    expect(out.join("")).not.toContain("Moeicons icon library");
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
  });
});
