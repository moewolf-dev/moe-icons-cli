import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
    // Fresh CI checkouts have no dist/; pack contents require a prior build.
    if (!existsSync(join(process.cwd(), "dist", "cli.js"))) {
      execSync("npm run build", { cwd: process.cwd(), stdio: "inherit" });
    }
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
      expect(files.some((f) => f.includes("package/bin/check-node.cjs"))).toBe(true);
      expect(files.some((f) => f.includes("package/dist/cli.js"))).toBe(true);
      expect(files).toContain("package/dist/generator/shared/svg-model.cjs");
      expect(files).toContain("package/dist/generator/shared/SOURCE.json");
      // no source, test, or secret files
      expect(files.some((f) => f.includes("tests/"))).toBe(false);
      expect(files.some((f) => f.includes("node_modules"))).toBe(false);
      expect(files.some((f) => f.includes(".env"))).toBe(false);
    } finally {
      rmSync(tarPath, { force: true });
    }
  });

  it("runs the new startup/diagnostic contracts from the packed tarball", () => {
    if (!existsSync(join(process.cwd(), "dist", "cli.js"))) {
      execSync("npm run build", { cwd: process.cwd(), stdio: "inherit" });
    }
    const output = execSync(`npm pack --pack-destination "${dir}" 2>/dev/null`, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const tarball = output.trim().split("\n").pop() ?? "";
    const extractRoot = mkdtempSync(join(process.cwd(), ".tmp-packed-"));
    const project = mkdtempSync(join(tmpdir(), "moeicons-packed-project-"));
    try {
      mkdirSync(extractRoot, { recursive: true });
      execSync(`tar -xzf "${join(dir, tarball)}" -C "${extractRoot}"`, { stdio: "pipe" });
      const bin = join(extractRoot, "package", "bin", "moeicons.js");
      const packedVersion = JSON.parse(
        readFileSync(join(extractRoot, "package", "package.json"), "utf8"),
      ) as { version: string; engines: { node: string } };
      expect(packedVersion.engines.node).toBe(">=24.0.0");

      expect(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim()).toBe(
        packedVersion.version,
      );
      expect(execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" })).toContain(
        "--export-diagnostics",
      );

      const lowNode = (() => {
        try {
          execFileSync(process.execPath, [bin, "--json", "--version"], {
            encoding: "utf8",
            env: { ...process.env, MOEICONS_TEST_MODE: "1", MOEICONS_TEST_NODE_VERSION: "v22.0.0" },
          });
          return { code: 0, stdout: "", stderr: "" };
        } catch (error) {
          const failure = error as { status?: number; stdout?: string; stderr?: string };
          return {
            code: failure.status ?? 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
          };
        }
      })();
      expect(lowNode.code).toBe(1);
      expect(JSON.parse(lowNode.stdout)).toMatchObject({ code: "NODE_VERSION_UNSUPPORTED" });

      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "packed-fixture", version: "1.0.0" }),
      );
      const cache = join(project, "cache");
      const diagnostics = execFileSync(
        process.execPath,
        [bin, "doctor", "--export-diagnostics", "--json"],
        {
          cwd: project,
          encoding: "utf8",
          env: { ...process.env, MOEICONS_CACHE_DIR: cache },
        },
      );
      const body = JSON.parse(diagnostics) as { ok: boolean; exported: boolean; bytes: number };
      expect(body).toMatchObject({ ok: true, exported: true });
      expect(body.bytes).toBeGreaterThan(0);
    } finally {
      rmSync(extractRoot, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
