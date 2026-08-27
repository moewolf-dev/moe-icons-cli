import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, type CliRuntime } from "../src/cli.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";

/**
 * E2E-03: free CLI disposable-project flow. Global/local invocation, confirmed
 * root, config generation, and idempotent reinstall.
 */

function makeRuntime(env: Record<string, string | undefined> = {}, auth?: CliRuntime["auth"]) {
  const out: string[] = [];
  const err: string[] = [];
  let cwd = "";
  return {
    runtime: {
      cwd: () => cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env,
      isTTY: () => false,
      readLine: async () => "",
      readKey: async () => "",
      ...(auth ? { auth } : {}),
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
  let releaseDir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-free-"));
    releaseDir = mkdtempSync(join(tmpdir(), "e2e-free-release-"));
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

  it("detects the project root and reports the free install plan", async () => {
    const { runtime, out, setCwd } = makeRuntime(env);
    setCwd(dir);
    const code = await main(["install", "free", "--json"], runtime);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      projectRoot: string;
      group: string;
      ok: boolean;
      artifactVersion: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.projectRoot).toBe(dir);
    expect(parsed.group).toBe("free");
    expect(parsed.artifactVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("creates the moeicons managed output on install", async () => {
    const { runtime, setCwd } = makeRuntime(env);
    setCwd(dir);
    await main(["install", "--json"], runtime);
    expect(existsSync(join(dir, "src", "moeicons", ".moeicons-free.marker"))).toBe(true);
    expect(existsSync(join(dir, "src", "moeicons", "types.ts"))).toBe(true);
    expect(existsSync(join(dir, ".moeicons", "install-metadata.json"))).toBe(true);
  });

  it("reruns idempotently without corrupting prior output", async () => {
    const { runtime, setCwd } = makeRuntime(env);
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
      const { runtime, out, err, setCwd } = makeRuntime(env);
      setCwd(outside);
      const code = await main(["install", "--json"], runtime);
      expect(code).toBe(1);
      expect(err).toEqual([]);
      const parsed = JSON.parse(out.join("")) as { ok: boolean; code: string; message: string };
      expect(parsed).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(parsed.message).toContain("no package.json");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("installs pro through authenticated descriptor and signed bytes", async () => {
    const meta = writeFreeReleaseFixture(releaseDir, { tier: "pro" });
    const archive = new Uint8Array(readFileSync(join(releaseDir, meta.freeName)));
    const metadataArchive = new Uint8Array(readFileSync(join(releaseDir, meta.metadataName)));
    const session: StoredSession = { accountId: "auth0|user", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, scope: "openid", storedAt: 1 };
    const tokenStore: TokenStore = { get: () => session, getActive: () => session, set() {}, delete() {}, clear() {} };
    const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/icon-library/versions")) return Response.json({ schemaVersion: 1, free: null, pro: { version: meta.version, releasedAt: "2026-08-24T00:00:00Z", descriptorSha256: meta.descriptorSha } });
      if (url.includes("artifact-descriptor")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
        return Response.json({ ok: true, tier: "pro", version: meta.version, descriptorSha256: meta.descriptorSha, catalogFilename: "catalog.json", catalogSha256: meta.catalogSha, url: "https://06898acc14d0b9633f259fe20145fd49.r2.cloudflarestorage.com/pro.tgz", expiresAt: "2099-01-01T00:00:00Z", size: archive.byteLength, sha256: meta.freeSha, metadata: { url: "https://06898acc14d0b9633f259fe20145fd49.r2.cloudflarestorage.com/pro-meta.tgz", expiresAt: "2099-01-01T00:00:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha } });
      }
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(url.includes("pro-meta") ? metadataArchive : archive);
    };
    const config = { schemaVersion: 1, tier: "pro", framework: "react", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } }, icons: ["ui-search"] };
    writeFileSync(join(dir, "moeicons.config.jsonc"), JSON.stringify(config));
    const { runtime, out, setCwd } = makeRuntime(env, { tokenStore, fetch: fetch as typeof globalThis.fetch });
    setCwd(dir);
    const code = await main(["install", "pro", "--json"], runtime);
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: true, group: "pro", artifactVersion: meta.version,
    });
    expect(existsSync(join(dir, "src", "moeicons", ".moeicons-pro.marker"))).toBe(true);
  });
});
