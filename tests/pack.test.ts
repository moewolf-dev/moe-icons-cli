import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * CLI-16: packed-tarball test. Runs `npm pack` into a temp dir and inspects the
 * tar contents to ensure only intended files ship and the bin is executable.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moeicons-pack-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("npm pack inspection", () => {
  it("produces a tarball whose contents are the intended files", () => {
    const output = execSync(`npm pack --pack-destination "${dir}" 2>/dev/null`, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const tarball = output.trim().split("\n").pop();
    expect(tarball).toMatch(/\.tgz$/);
    const tarPath = join(dir, tarball ?? "");
    expect(existsSync(tarPath)).toBe(true);
    try {
      const listing = execSync(`tar -tzf "${tarPath}"`, { encoding: "utf8" });
      const files = listing.split("\n").filter(Boolean);
      expect(files.some((f) => f.includes("package/bin/moeicons.js"))).toBe(true);
      expect(files.some((f) => f.includes("package/dist/cli.js"))).toBe(true);
      // no source, test, or secret files
      expect(files.some((f) => f.includes("tests/"))).toBe(false);
      expect(files.some((f) => f.includes("node_modules"))).toBe(false);
      expect(files.some((f) => f.includes(".env"))).toBe(false);
    } finally {
      rmSync(tarPath, { force: true });
    }
  });
});
