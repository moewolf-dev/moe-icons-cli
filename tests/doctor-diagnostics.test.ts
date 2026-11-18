import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_TTL_MS,
  DIAGNOSTIC_FILE_PREFIX,
  MAX_BUNDLE_BYTES,
  buildDiagnosticBundle,
  diagnosticFileName,
  exportDiagnosticBundle,
  pruneDiagnosticBundles,
} from "../src/core/doctor-diagnostics.js";
import { DiagnosticRecorder } from "../src/core/diagnostics.js";
import { main } from "../src/cli.js";

let dir: string;
let cache: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moeicons-diag-project-"));
  cache = mkdtempSync(join(tmpdir(), "moeicons-diag-cache-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(
    join(dir, "moeicons.config.jsonc"),
    JSON.stringify({
      schemaVersion: 3,
      tier: "free",
      target: "react",
      outputDir: "src/moeicons",
      defaultTheme: "outline",
      themes: { outline: { styleGroup: "outline" } },
      icons: [],
    }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

const input = () => ({
  cwd: dir,
  env: { SHELL: "/bin/zsh", CI: "true" },
  cliVersion: "9.9.9",
  nodeVersion: "v24.0.0",
  platform: "darwin",
  arch: "arm64",
  stdinTTY: true,
  stdoutTTY: true,
  stderrTTY: true,
  columns: 80,
  installSource: "global:npm",
  diagnostics: new DiagnosticRecorder(),
  now: new Date("2026-11-18T00:00:00Z"),
});

describe("REF-09 diagnostic bundle", () => {
  it("contains startup/config/anchor facts without home paths, tokens or email", () => {
    const recorder = new DiagnosticRecorder();
    recorder.record({
      level: "error",
      message: "failed for buyer@example.com",
      code: "NETWORK_ERROR",
      phase: "network",
    });
    const text = buildDiagnosticBundle({ ...input(), diagnostics: recorder });
    expect(text).toContain("moeicons diagnostics v1");
    expect(text).toContain("node: v24.0.0");
    expect(text).toContain("os: darwin/arm64");
    expect(text).toContain("shell: zsh");
    expect(text).toContain("ci: true");
    expect(text).toContain("installSource: global:npm");
    expect(text).toContain("anchor.manifest:");
    expect(text).toContain("anchor.config:");
    expect(text).toMatch(/config(:|\.fields:)/);
    expect(text).not.toContain("buyer@example.com");
    expect(text).not.toMatch(/\/Users\/[^/\s]+/);
    expect(text).not.toContain("token=");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
  });

  it("exports one 24h bundle with a safe file name", () => {
    const exported = exportDiagnosticBundle({
      directory: join(cache, "diagnostics"),
      input: input(),
      random: () => "abc123",
    });
    expect(existsSync(exported.path)).toBe(true);
    expect(exported.path).toContain(DIAGNOSTIC_FILE_PREFIX);
    expect(exported.path).toContain("9.9.9");
    expect(exported.path).toContain("abc123");
    expect(exported.expiresAt).toBe(
      new Date(Date.parse("2026-11-18T00:00:00Z") + BUNDLE_TTL_MS).toISOString(),
    );
    expect(exported.bytes).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
    expect(readFileSync(exported.path, "utf8")).toContain("moeicons diagnostics v1");
  });

  it("expires old bundles and keeps at most five files", () => {
    const diagnostics = join(cache, "diagnostics");
    mkdirSync(diagnostics, { recursive: true });
    const now = new Date("2026-11-18T00:00:00Z");
    for (let index = 0; index < 7; index += 1) {
      const path = join(
        diagnostics,
        diagnosticFileName("1.0.0", new Date(now.getTime() - index * 1_000), () => `a${index}`),
      );
      writeFileSync(path, "bundle");
      utimesSync(path, now, new Date(now.getTime() - index * 1_000));
    }
    const expired = join(
      diagnostics,
      diagnosticFileName("1.0.0", new Date(now.getTime() - BUNDLE_TTL_MS - 1_000), () => "old"),
    );
    writeFileSync(expired, "bundle");
    utimesSync(
      expired,
      new Date(now.getTime() - BUNDLE_TTL_MS - 1_000),
      new Date(now.getTime() - BUNDLE_TTL_MS - 1_000),
    );
    const removed = pruneDiagnosticBundles(diagnostics, { now });
    expect(removed.some((path) => path.endsWith("old.txt"))).toBe(true);
    const live = readdirSync(diagnostics).filter((name) => name.startsWith(DIAGNOSTIC_FILE_PREFIX));
    expect(live.length).toBeLessThanOrEqual(5);
  });

  it("does not create a file for a plain doctor run", async () => {
    const env = { MOEICONS_CACHE_DIR: cache };
    const runtime = {
      cwd: () => dir,
      stdout: () => undefined,
      stderr: () => undefined,
      env,
      isTTY: () => false,
    };
    expect(await main(["doctor", "--json"], runtime)).toBe(0);
    expect(existsSync(join(cache, "diagnostics"))).toBe(false);
  });

  it("writes a bundle and returns a JSON preview for doctor --export-diagnostics", async () => {
    const out: string[] = [];
    let code = -1;
    const runtime = {
      cwd: () => dir,
      stdout: (text: string) => out.push(text),
      stderr: () => undefined,
      env: { MOEICONS_CACHE_DIR: cache },
      isTTY: () => false,
    };
    code = await main(["doctor", "--export-diagnostics", "--json"], runtime);
    expect(code).toBe(0);
    const body = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.exported).toBe(true);
    expect(body.bytes).toBeGreaterThan(0);
    expect(String(body.path)).toContain("moeicons-diag-");
    expect(String(body.preview)).toContain("moeicons diagnostics v1");
    expect(statSync(String(body.path)).isFile()).toBe(true);
  });

  it("prunes expired bundles at startup without failing the command", async () => {
    const diagnostics = join(cache, "diagnostics");
    mkdirSync(diagnostics, { recursive: true });
    const old = join(
      diagnostics,
      diagnosticFileName("0.0.1", new Date("2020-01-01T00:00:00Z"), () => "old1"),
    );
    writeFileSync(old, "x");
    utimesSync(old, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const runtime = {
      cwd: () => dir,
      stdout: () => undefined,
      stderr: () => undefined,
      env: { MOEICONS_CACHE_DIR: cache },
      isTTY: () => false,
    };
    expect(await main(["--version"], runtime)).toBe(0);
    expect(existsSync(old)).toBe(false);
  });
});
