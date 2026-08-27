import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  renameSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstallUseCase } from "../src/core/install.js";
import { runProInstallUseCase } from "../src/core/pro-install.js";
import { runLibraryUpdateUseCase } from "../src/core/library-update.js";
import { runGenerateUseCase } from "../src/core/generate.js";
import { readMoeiconsConfig } from "../src/project/config.js";
import { parseInstallMetadata, readInstalledResourceState } from "../src/project/install-metadata.js";
import { downloadProArtifact } from "../src/core/pro-download.js";
import type { CommandContext, CommandUi } from "../src/core/context.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";
import { DESCRIPTOR_NAME } from "../src/core/free-download.js";
import { writeFreeReleaseFixture, targetSubtreeFiles } from "./helpers/free-release-fixture.js";
import type { Target } from "../src/commands/parser.js";

const TARGETS: readonly Target[] = ["react", "vue", "vanilla", "assets"];

function fakeUi(): CommandUi {
  return {
    select: async () => "free",
    confirm: async () => true,
    text: async () => "",
    note() {
      return undefined;
    },
    progress() {
      return { stop() { return undefined; } };
    },
  };
}

function context(cwd: string, env: Record<string, string> = {}): CommandContext {
  return {
    ui: fakeUi(),
    cwd,
    env,
    signal: new AbortController().signal,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  };
}

function session(): StoredSession {
  return {
    accountId: "auth0|b7",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 60_000,
    scope: "openid",
    storedAt: 1,
  };
}

function tokenStore(initial: StoredSession): TokenStore {
  let value: StoredSession | undefined = initial;
  return { get: () => value, getActive: () => value, set: (next) => { value = next; }, delete: () => { value = undefined; }, clear: () => { value = undefined; } };
}

const realFs = { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync };
const realFsWithCopy = { ...realFs, readdirSync, copyFileSync };

describe("B7: 2 tiers x 4 targets routing and target subtree install", () => {
  let project: string;
  let fixture: string;
  let cache: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "b7-project-"));
    fixture = mkdtempSync(join(tmpdir(), "b7-fixture-"));
    cache = mkdtempSync(join(tmpdir(), "b7-cache-"));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "b7", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function freeDeps() {
    return {
      fs: realFs,
      download: {
        fetchFn: globalThis.fetch.bind(globalThis),
        readFileSync: (path: string) => new Uint8Array(readFileSync(path)),
        writeFileSync: (path: string, data: Uint8Array) => {
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, data);
        },
        mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
        existsSync,
        renameSync,
        rmSync,
        fixtureDir: fixture,
        cacheDir: cache,
        cliVersion: "0.1.0",
      },
    };
  }

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(join(project, "moeicons.config.json"), JSON.stringify(config));
  }

  it("routes free installs for all four targets and lands only the selected subtree", async () => {
    writeFreeReleaseFixture(fixture);
    for (const target of TARGETS) {
      const result = await runInstallUseCase(context(project), freeDeps(), { group: "free", target });
      expect(result).toMatchObject({ ok: true, group: "free", target });
      const expected = targetSubtreeFiles()[target];
      for (const [rel] of Object.entries(expected)) {
        expect(existsSync(join(project, ".moeicons", "artifact", target, rel)), `${target}/${rel}`).toBe(true);
      }
      for (const other of TARGETS) {
        if (other !== target) {
          expect(existsSync(join(project, ".moeicons", "artifact", other)), `${target} must not install ${other}`).toBe(false);
        }
      }
      expect(readInstalledResourceState(project, "free").kind).toBe("ok");
      // reset between targets
      rmSync(join(project, ".moeicons"), { recursive: true, force: true });
      rmSync(join(project, "src"), { recursive: true, force: true });
    }
  });

  it("routes pro installs for all four targets through the authenticated flow with a local mock", async () => {
    writeConfig({ schemaVersion: 2, tier: "pro", target: "react", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } }, icons: ["ui-search"] });
    for (const target of TARGETS) {
      const meta = writeFreeReleaseFixture(fixture, { tier: "pro" });
      const archive = new Uint8Array(readFileSync(join(fixture, meta.freeName)));
      const metadataArchive = new Uint8Array(readFileSync(join(fixture, meta.metadataName)));
      const descriptor = JSON.parse(readFileSync(join(fixture, DESCRIPTOR_NAME), "utf8")) as {
        free: { targetMetadata: Record<string, unknown> };
      };
      const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (url.includes("artifact-descriptor")) {
          return Response.json({
            ok: true,
            tier: "pro",
            version: meta.version,
            descriptorSha256: meta.descriptorSha,
            catalogFilename: "catalog.json",
            catalogSha256: meta.catalogSha,
            url: "https://06898acc14d0b9633f259fe20145fd49.r2.cloudflarestorage.com/pro.tgz",
            expiresAt: "2099-01-01T00:00:00Z",
            size: archive.byteLength,
            sha256: meta.freeSha,
            targetMetadata: descriptor.free.targetMetadata,
            metadata: { url: "https://06898acc14d0b9633f259fe20145fd49.r2.cloudflarestorage.com/pro-meta.tgz", expiresAt: "2099-01-01T00:00:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha },
          });
        }
        return new Response(url.includes("pro-meta") ? metadataArchive : archive);
      });
      const result = await runProInstallUseCase(
        context(project),
        { fs: realFs, auth: { tokenStore: tokenStore(session()) }, fetch: fetch as typeof fetch, allowedHosts: ["06898acc14d0b9633f259fe20145fd49.r2.cloudflarestorage.com"] },
        { version: meta.version, descriptorSha256: meta.descriptorSha, target },
      );
      expect(result.artifactVersion).toBe(meta.version);
      const expected = targetSubtreeFiles()[target];
      for (const [rel] of Object.entries(expected)) {
        expect(existsSync(join(project, ".moeicons", "artifact", target, rel)), `${target}/${rel}`).toBe(true);
      }
      for (const other of TARGETS) {
        if (other !== target) {
          expect(existsSync(join(project, ".moeicons", "artifact", other)), `${target} must not install ${other}`).toBe(false);
        }
      }
      const metadata = parseInstallMetadata(readFileSync(join(project, ".moeicons", "install-metadata.json"), "utf8"));
      expect(metadata?.tier).toBe("pro");
      expect(metadata?.target).toBe(target);
      expect(readInstalledResourceState(project, "pro").kind).toBe("ok");
      rmSync(join(project, ".moeicons"), { recursive: true, force: true });
      rmSync(join(project, "src"), { recursive: true, force: true });
    }
  });

  it("never forwards API credentials to the signed pro host while landing the subtree", async () => {
    writeConfig({ schemaVersion: 2, tier: "pro", target: "assets", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } }, icons: ["ui-search"] });
    const meta = writeFreeReleaseFixture(fixture, { tier: "pro" });
    const archive = new Uint8Array(readFileSync(join(fixture, meta.freeName)));
    const metadataArchive = new Uint8Array(readFileSync(join(fixture, meta.metadataName)));
    const descriptor = JSON.parse(readFileSync(join(fixture, DESCRIPTOR_NAME), "utf8")) as {
      free: { targetMetadata: Record<string, unknown> };
    };
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.includes("artifact-descriptor")) {
        return Response.json({
          ok: true, tier: "pro", version: meta.version, descriptorSha256: meta.descriptorSha,
          catalogFilename: "catalog.json", catalogSha256: meta.catalogSha,
          url: "https://signed.example/pro.tgz", expiresAt: "2099-01-01T00:00:00Z",
          size: archive.byteLength, sha256: meta.freeSha, targetMetadata: descriptor.free.targetMetadata,
          metadata: { url: "https://signed.example/pro-meta.tgz", expiresAt: "2099-01-01T00:00:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha },
        });
      }
      return new Response(url.includes("pro-meta") ? metadataArchive : archive);
    });
    await runProInstallUseCase(
      context(project),
      { fs: realFs, auth: { tokenStore: tokenStore(session()) }, fetch: fetch as typeof fetch, allowedHosts: ["signed.example"] },
      { version: meta.version, descriptorSha256: meta.descriptorSha, target: "assets" },
    );
    expect(calls.find((call) => call.url.includes("artifact-descriptor"))?.authorization).toBe("Bearer access-token");
    expect(calls.find((call) => call.url.includes("signed.example"))?.authorization).toBeNull();
    expect(JSON.stringify(calls)).not.toContain("refresh-token");
  });
});

describe("B7: failure and rollback contracts", () => {
  let project: string;
  let fixture: string;
  let cache: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "b7-fail-"));
    fixture = mkdtempSync(join(tmpdir(), "b7-fail-fixture-"));
    cache = mkdtempSync(join(tmpdir(), "b7-fail-cache-"));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "b7", version: "1.0.0" }));
    writeFreeReleaseFixture(fixture);
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function freeDeps(fsOverrides: Partial<Parameters<typeof runInstallUseCase>[1]["fs"]> = {}) {
    return {
      fs: { ...realFs, ...fsOverrides },
      download: {
        fetchFn: globalThis.fetch.bind(globalThis),
        readFileSync: (path: string) => new Uint8Array(readFileSync(path)),
        writeFileSync: (path: string, data: Uint8Array) => {
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, data);
        },
        mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
        existsSync,
        renameSync,
        rmSync,
        fixtureDir: fixture,
        cacheDir: cache,
        cliVersion: "0.1.0",
      },
    };
  }

  it("rejects an unknown target in v2 config with a validation error and zero writes", async () => {
    writeFileSync(
      join(project, "moeicons.config.json"),
      JSON.stringify({ schemaVersion: 2, tier: "free", target: "solid", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } }, icons: ["ui-search"] }),
    );
    expect(readMoeiconsConfig(project).kind).toBe("invalid");
    const result = await runInstallUseCase(context(project), freeDeps(), { group: "free" });
    expect(result).toMatchObject({ ok: false, reason: "validation" });
    if (result.ok === false && result.reason === "validation") {
      expect(result.message).toContain("target");
    }
    expect(existsSync(join(project, ".moeicons"))).toBe(false);
  });

  it("fails closed when a target subtree checksum mismatches the descriptor", async () => {
    rmSync(fixture, { recursive: true, force: true });
    fixture = mkdtempSync(join(tmpdir(), "b7-fail-tamper-"));
    writeFreeReleaseFixture(fixture, { tamperTarget: "vanilla" });
    const result = await runInstallUseCase(context(project), freeDeps(), { group: "free", target: "vanilla" });
    expect(result).toMatchObject({ ok: false, reason: "checksum-mismatch" });
    if (result.ok === false && result.reason === "checksum-mismatch") {
      expect(result.message).toContain("vanilla");
    }
    expect(existsSync(join(project, ".moeicons"))).toBe(false);
  });

  it("rolls back all project files when the transactional write fails mid-install", async () => {
    let renames = 0;
    const result = await runInstallUseCase(
      context(project),
      freeDeps({
        renameSync: (...args: Parameters<typeof renameSync>) => {
          renames += 1;
          if (renames === 3) throw new Error("simulated rename failure");
          return renameSync(...args);
        },
      }),
      { group: "free", target: "assets" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("write-failed");
    expect(existsSync(join(project, ".moeicons", "install-metadata.json"))).toBe(false);
    expect(existsSync(join(project, "src", "moeicons", ".moeicons-free.marker"))).toBe(false);
    expect(existsSync(join(project, ".moeicons", "artifact", "assets", "manifest.json"))).toBe(false);
  });
});

describe("B7: v1->v2 migration, update preservation and dependency isolation", () => {
  let project: string;
  let fixture: string;
  let nextFixture: string;
  let cache: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "b7-migrate-"));
    fixture = mkdtempSync(join(tmpdir(), "b7-migrate-old-"));
    nextFixture = mkdtempSync(join(tmpdir(), "b7-migrate-next-"));
    cache = mkdtempSync(join(tmpdir(), "b7-migrate-cache-"));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "b7", version: "1.0.0", dependencies: {} }));
  });
  afterEach(() => {
    for (const path of [project, fixture, nextFixture, cache]) rmSync(path, { recursive: true, force: true });
  });

  function download(fixtureDir: string) {
    return {
      fetchFn: globalThis.fetch.bind(globalThis),
      readFileSync: (path: string) => new Uint8Array(readFileSync(path)),
      writeFileSync: (path: string, data: Uint8Array) => {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, data);
      },
      mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
      existsSync,
      renameSync,
      rmSync,
      fixtureDir,
      cacheDir: cache,
      cliVersion: "0.1.0",
    };
  }

  it("migrates a v1 framework config to a v2 target on install and never defaults", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    writeFileSync(
      join(project, "moeicons.config.json"),
      JSON.stringify({ schemaVersion: 1, tier: "free", framework: "vue", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } }, icons: ["ui-search"] }),
    );
    const loaded = readMoeiconsConfig(project);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind === "ok") {
      expect(loaded.config.schemaVersion).toBe(2);
      expect(loaded.config.target).toBe("vue");
      expect(("framework" in loaded.config)).toBe(false);
      expect(loaded.warnings).toContain('config schema v1 migrated "framework" to "target"');
    }
    const result = await runInstallUseCase(context(project), { fs: realFs, download: download(fixture) }, { group: "free", sourceVersion: meta.version });
    expect(result).toMatchObject({ ok: true, target: "vue" });
    const metadata = parseInstallMetadata(readFileSync(join(project, ".moeicons", "install-metadata.json"), "utf8"));
    expect(metadata?.target).toBe("vue");
  });

  it("library update preserves the installed target and its verified subtree", async () => {
    const old = writeFreeReleaseFixture(fixture);
    writeFileSync(
      join(project, "moeicons.config.json"),
      JSON.stringify({ schemaVersion: 2, tier: "free", target: "assets", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } }, icons: ["arrow-bold-right"] }),
    );
    const first = await runInstallUseCase(context(project), { fs: realFs, download: download(fixture) }, { group: "free", sourceVersion: old.version });
    expect(first).toMatchObject({ ok: true, target: "assets" });
    const next = writeFreeReleaseFixture(nextFixture, { version: "0.0.18", useBundledCatalog: true });
    const updated = await runLibraryUpdateUseCase(
      context(project),
      { fs: realFsWithCopy, free: download(nextFixture), auth: {} },
      { tier: "free", version: next.version, descriptorSha256: next.descriptorSha },
    );
    expect(updated.artifactVersion).toBe("0.0.18");
    const metadata = parseInstallMetadata(readFileSync(join(project, ".moeicons", "install-metadata.json"), "utf8"));
    expect(metadata?.target).toBe("assets");
    expect(metadata?.targetSha256).toMatch(/^[0-9a-f]{64}$/);
    const expected = targetSubtreeFiles().assets;
    for (const [rel] of Object.entries(expected)) {
      expect(existsSync(join(project, ".moeicons", "artifact", "assets", rel)), rel).toBe(true);
    }
    expect(existsSync(join(project, ".moeicons", "artifact", "react"))).toBe(false);
  });

  it("install then generate works for vanilla/assets without injected archiveFiles", async () => {
    writeFreeReleaseFixture(fixture, { useBundledCatalog: true });
    for (const target of ["vanilla", "assets"] as const) {
      writeFileSync(
        join(project, "moeicons.config.json"),
        JSON.stringify({
          schemaVersion: 2,
          tier: "free",
          target,
          outputDir: "src/moeicons",
          defaultTheme: "outline",
          themes: { outline: { styleGroup: "moe-outline" } },
          icons: ["arrow-bold-right"],
        }),
      );
      const installed = await runInstallUseCase(
        context(project, { MOEICONS_CACHE_DIR: cache }),
        { fs: realFs, download: download(fixture) },
        { group: "free", target },
      );
      expect(installed.ok, `${target} install`).toBe(true);
      const generated = await runGenerateUseCase(
        context(project, { MOEICONS_CACHE_DIR: cache }),
        realFsWithCopy,
        { noTailwind: true },
      );
      expect(generated.ok, `${target} generate: ${JSON.stringify(generated)}`).toBe(true);
      if (target === "assets") {
        expect(existsSync(join(project, "src", "moeicons", "assets", "moe-outline", "arrow-bold-right.svg"))).toBe(true);
      } else {
        expect(existsSync(join(project, "src", "moeicons", "moe-outline", "ArrowBoldRight.ts"))).toBe(true);
      }
      rmSync(join(project, ".moeicons"), { recursive: true, force: true });
      rmSync(join(project, "src"), { recursive: true, force: true });
      rmSync(join(project, "moeicons.config.json"), { force: true });
    }
  });

  it("vanilla and assets targets never pull react/vue/clsx/tailwind-merge dependencies", async () => {
    writeFreeReleaseFixture(fixture, { useBundledCatalog: true });
    for (const target of ["vanilla", "assets"] as const) {
      writeFileSync(
        join(project, "moeicons.config.json"),
        JSON.stringify({
          schemaVersion: 2,
          tier: "free",
          target,
          outputDir: "src/moeicons",
          defaultTheme: "outline",
          themes: { outline: { styleGroup: "moe-outline" } },
          icons: ["arrow-bold-right"],
        }),
      );
      const installed = await runInstallUseCase(
        context(project, { MOEICONS_CACHE_DIR: cache }),
        { fs: realFs, download: download(fixture) },
        { group: "free", target },
      );
      expect(installed.ok, `${target} install`).toBe(true);
      const result = await runGenerateUseCase(
        context(project, { MOEICONS_CACHE_DIR: cache }),
        realFsWithCopy,
        { noTailwind: true },
      );
      expect(result.ok, `${target} generate`).toBe(true);
      const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.clsx, `${target} adds clsx`).toBeUndefined();
      expect(pkg.dependencies?.["tailwind-merge"], `${target} adds tailwind-merge`).toBeUndefined();
      expect(pkg.dependencies?.react, `${target} adds react`).toBeUndefined();
      expect(pkg.dependencies?.vue, `${target} adds vue`).toBeUndefined();
      rmSync(join(project, ".moeicons"), { recursive: true, force: true });
      rmSync(join(project, "src"), { recursive: true, force: true });
      rmSync(join(project, "moeicons.config.json"), { force: true });
    }
  });
});
