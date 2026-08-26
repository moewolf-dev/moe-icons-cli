import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Release dry-run: never publishes, defaults to patch only, refuses --major/
 * --minor (x/y are human-owned), and blocks on a dirty tree.
 */

let dir: string;
const script = resolve("scripts/release-dry-run.mjs");

function run(cmd: string): string {
  return execSync(cmd, { cwd: dir, encoding: "utf8" }).trim();
}

function runScript(args: string[] = []): string {
  return execSync(`node "${script}" ${args.join(" ")}`, { cwd: dir, encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moeicons-release-"));
  run("git init -q");
  run('git config user.email test@example.com');
  run('git config user.name test');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@moewolf/moe-icons-cli", version: "0.0.1" }));
  run("git add package.json");
  run('git commit -q -m "init"');
  run("git branch -M main");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("release-dry-run", () => {
  it("blocks on --publish (never publishes)", () => {
    expect(() => runScript(["--publish"])).toThrow();
  });

  it("defaults to a patch bump and writes a changelog entry", () => {
    const out = runScript();
    const parsed = JSON.parse(out) as {
      ok: boolean;
      currentVersion: string;
      proposedVersion: string;
      bump: string;
      published: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.bump).toBe("patch");
    expect(parsed.currentVersion).toBe("0.0.1");
    expect(parsed.proposedVersion).toBe("0.0.2");
    expect(parsed.published).toBe(false);
    expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(true);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("0.0.2");
  });

  it("refuses --major/--minor so x/y stay human-owned", () => {
    expect(() => runScript(["--major"])).toThrow(/major\/minor|manually/i);
    expect(() => runScript(["--minor"])).toThrow(/major\/minor|manually/i);
    expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(false);
  });

  it("blocks on a dirty working tree", () => {
    writeFileSync(join(dir, "dirty.txt"), "x");
    expect(() => runScript()).toThrow();
  });
});
