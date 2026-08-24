import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * CLI-16: packed-tarball invocation matrix. Packs the CLI, installs the tarball
 * into disposable fixtures via npm and pnpm, then invokes the installed bin
 * without touching a real project. Proves `moeicons --version`/`--help` work
 * from a fresh install on the local platform.
 */

let cwd: string;
let fixture: string;

function run(cmd: string, opts: { cwd?: string; throwOnError?: boolean } = {}): string {
  return execSync(cmd, {
    cwd: opts.cwd ?? cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.throwOnError === false ? {} : {}),
  });
}

function hasPnpm(): boolean {
  try {
    execSync("pnpm --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  cwd = process.cwd();
  fixture = mkdtempSync(join(tmpdir(), "moeicons-invoke-"));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("CLI-16 packed-tarball invocation matrix", () => {
  it("npm pack produces a tarball the npm install step can consume", () => {
    const packDir = mkdtempSync(join(tmpdir(), "moeicons-pack-"));
    const output = run(`npm pack --pack-destination "${packDir}" 2>/dev/null`);
    const tarball = output.trim().split("\n").pop() ?? "";
    expect(tarball).toMatch(/\.tgz$/);
    expect(existsSync(join(packDir, tarball))).toBe(true);
    rmSync(packDir, { recursive: true, force: true });
  });

  it("npm install of the tarball then invokes moeicons --version without modifying a real project", () => {
    // fresh project fixture
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "invoke-fixture", version: "1.0.0" }));
    const output = run("npm pack --pack-destination /tmp 2>/dev/null", { cwd });
    const tarballName = output.trim().split("\n").pop() ?? "";
    const tarball = join("/tmp", tarballName);
    expect(existsSync(tarball)).toBe(true);
    try {
      run(`npm install ${tarball} 2>/dev/null`, { cwd: fixture });
      const version = run("npx moeicons --version", { cwd: fixture }).trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      const help = run("npx moeicons --help", { cwd: fixture });
      expect(help.toLowerCase()).toContain("usage");
    } finally {
      rmSync(tarball, { force: true });
    }
  });

  it("global-style invocation from node_modules/.bin works (npm/npx path)", () => {
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "invoke-fixture", version: "1.0.0" }));
    const output = run("npm pack --pack-destination /tmp 2>/dev/null", { cwd });
    const tarballName = output.trim().split("\n").pop() ?? "";
    const tarball = join("/tmp", tarballName);
    expect(existsSync(tarball)).toBe(true);
    try {
      run(`npm install ${tarball} 2>/dev/null`, { cwd: fixture });
      const bin = join(fixture, "node_modules", ".bin", "moeicons");
      expect(existsSync(bin)).toBe(true);
      const version = run(`"${bin}" --version`).trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(tarball, { force: true });
    }
  });

  it("pnpm install of the tarball invokes the bin (pnpm invocation matrix)", (ctx) => {
    if (!hasPnpm()) {
      ctx.skip();
      return;
    }
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "invoke-fixture", version: "1.0.0" }));
    const output = run("npm pack --pack-destination /tmp 2>/dev/null", { cwd });
    const tarballName = output.trim().split("\n").pop() ?? "";
    const tarball = join("/tmp", tarballName);
    expect(existsSync(tarball)).toBe(true);
    try {
      run(`pnpm install ${tarball} --ignore-scripts 2>/dev/null`, { cwd: fixture });
      const bin = join(fixture, "node_modules", ".bin", "moeicons");
      expect(existsSync(bin)).toBe(true);
      const version = run(`"${bin}" --version`).trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(tarball, { force: true });
    }
  });
});
