import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstallUseCase } from "../src/core/install.js";
import { runMetadataSyncUseCase } from "../src/core/metadata-sync.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";
import type { CommandContext } from "../src/core/context.js";
import { readInstalledResourceState } from "../src/project/install-metadata.js";

function context(project: string, cacheDir: string): CommandContext {
  return {
    cwd: project,
    env: { MOEICONS_CACHE_DIR: cacheDir },
    signal: new AbortController().signal,
    now: () => new Date(),
    ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
  };
}

const realFs = { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, copyFileSync };

describe("metadata-only sync (MC.7 / update metadata)", () => {
  let project: string;
  let release: string;
  let cache: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "meta-sync-"));
    release = mkdtempSync(join(tmpdir(), "meta-sync-release-"));
    cache = mkdtempSync(join(tmpdir(), "meta-sync-cache-"));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "m", version: "1.0.0" }));
    writeFreeReleaseFixture(release);
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function freeDeps() {
    return {
      fetchFn: globalThis.fetch.bind(globalThis),
      readFileSync: (p: string) => new Uint8Array(readFileSync(p)),
      writeFileSync: (p: string, d: Uint8Array) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, d); },
      mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
      existsSync,
      renameSync,
      rmSync,
      fixtureDir: release,
      cacheDir: cache,
      cliVersion: "0.1.0",
    };
  }

  function metadataDeps() {
    return {
      fs: realFs,
      free: freeDeps(),
      auth: {},
    };
  }

  it("repairs missing metadata files without touching the code artifact", async () => {
    const installed = await runInstallUseCase(context(project, cache), { fs: realFs, download: freeDeps() }, {});
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    rmSync(join(project, ".moeicons", "MANUAL.md"), { force: true });
    rmSync(join(project, ".moeicons", "manifest.json"), { force: true });
    expect(readInstalledResourceState(project, "free").kind).toBe("invalid");

    const result = await runMetadataSyncUseCase(context(project, cache), metadataDeps(), {});
    expect(result.tier).toBe("free");
    expect(result.artifactVersion).toBe(installed.artifactVersion);
    expect(existsSync(join(project, ".moeicons", "MANUAL.md"))).toBe(true);
    expect(existsSync(join(project, ".moeicons", "manifest.json"))).toBe(true);
    expect(readInstalledResourceState(project, "free").kind).toBe("ok");
    const manifest = JSON.parse(readFileSync(join(project, ".moeicons", "manifest.json"), "utf8"));
    expect(manifest.libraryVersion).toBe(installed.artifactVersion);
  });

  it("fails when no managed install exists", async () => {
    await expect(runMetadataSyncUseCase(context(project, cache), metadataDeps(), {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});
