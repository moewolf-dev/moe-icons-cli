import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBootstrapUseCase, bootstrapMarkerPath } from "../src/core/bootstrap.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";
import type { CommandContext } from "../src/core/context.js";

function context(project: string, confirm: (message: string) => Promise<boolean | undefined>, cacheDir: string): CommandContext {
  return {
    cwd: project,
    env: { MOEICONS_CACHE_DIR: cacheDir },
    signal: new AbortController().signal,
    now: () => new Date(),
    ui: {
      select: async () => undefined,
      confirm: async (message) => confirm(message),
      text: async () => undefined,
      note() {},
      progress: () => ({ stop() {} }),
    },
  };
}

describe("first-run bootstrap (MD.1-MD.4)", () => {
  let dir: string;
  let release: string;
  let cache: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
    release = mkdtempSync(join(tmpdir(), "bootstrap-release-"));
    cache = mkdtempSync(join(tmpdir(), "bootstrap-cache-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b", version: "1.0.0" }));
    writeFreeReleaseFixture(release);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function deps(env: Record<string, string> = {}) {
    return {
      fs: {
        existsSync,
        readFileSync: (p: string) => readFileSync(p, "utf8"),
        writeFileSync: (p: string, content: string) => writeFileSync(p, content),
        mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
      },
      installFs: { mkdirSync, writeFileSync, existsSync, renameSync, rmSync },
      free: {
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
      },
      cliVersion: "0.1.0",
    };
  }

  it("installs free code + metadata on first interactive start and writes the marker", async () => {
    const result = await runBootstrapUseCase(context(dir, async () => true, cache), deps());
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") return;
    expect(result.version).toBeTruthy();
    expect(existsSync(join(dir, ".moeicons", "install-metadata.json"))).toBe(true);
    expect(existsSync(join(dir, ".moeicons", "MANUAL.md"))).toBe(true);
    expect(existsSync(join(dir, ".moeicons", "manifest.json"))).toBe(true);
    expect(existsSync(bootstrapMarkerPath({ MOEICONS_CACHE_DIR: cache }))).toBe(true);
  });

  it("writes a declined marker but never a completion marker when declined", async () => {
    const result = await runBootstrapUseCase(context(dir, async () => false, cache), deps());
    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") return;
    expect(result.reason).toBe("declined");
    const marker = bootstrapMarkerPath({ MOEICONS_CACHE_DIR: cache });
    expect(existsSync(marker)).toBe(true);
    const body = JSON.parse(readFileSync(marker, "utf8"));
    expect(body.declinedAt).toBeTruthy();
    expect(body.completedAt).toBeUndefined();
  });

  it("skips without a project and does not write a marker", async () => {
    const outside = mkdtempSync(join(tmpdir(), "bootstrap-outside-"));
    try {
      const result = await runBootstrapUseCase(context(outside, async () => true, cache), deps());
      expect(result.kind).toBe("skipped");
      expect(existsSync(bootstrapMarkerPath({ MOEICONS_CACHE_DIR: cache }))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("skips when a valid free install already exists (and marks complete)", async () => {
    const first = await runBootstrapUseCase(context(dir, async () => true, cache), deps());
    expect(first.kind).toBe("installed");
    const second = await runBootstrapUseCase(context(dir, async () => true, cache), deps());
    expect(second.kind).toBe("already");
  });

  it("never suppresses retry after a failed download", async () => {
    rmSync(release, { recursive: true, force: true });
    mkdirSync(release);
    writeFreeReleaseFixture(release, { wrongDescriptorSha: true });
    const result = await runBootstrapUseCase(context(dir, async () => true, cache), deps());
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.retry).toBe("moeicons install free");
      expect(existsSync(bootstrapMarkerPath({ MOEICONS_CACHE_DIR: cache }))).toBe(false);
    }
  });

  it("is a no-op when the marker already exists", async () => {
    writeFileSync(bootstrapMarkerPath({ MOEICONS_CACHE_DIR: cache }), "{}");
    const result = await runBootstrapUseCase(context(dir, async () => true, cache), deps());
    expect(result.kind).toBe("already");
  });
});
