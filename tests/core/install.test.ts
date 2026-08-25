import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstallUseCase } from "../../src/core/install.js";
import { readInstalledResourceState } from "../../src/project/install-metadata.js";
import type { CommandContext, CommandUi } from "../../src/core/context.js";
import { writeFreeReleaseFixture } from "../helpers/free-release-fixture.js";

function fakeUi(): CommandUi {
  return {
    select: async () => "free",
    confirm: async () => true,
    text: async () => "",
    note() {
      return undefined;
    },
    progress() {
      return {
        stop() {
          return undefined;
        },
      };
    },
  };
}

function context(cwd: string, signal = new AbortController().signal): CommandContext {
  return {
    ui: fakeUi(),
    cwd,
    env: {},
    signal,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  };
}

describe("runInstallUseCase", () => {
  let project: string;
  let fixture: string;
  let cache: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "install-project-"));
    fixture = mkdtempSync(join(tmpdir(), "install-fixture-"));
    cache = mkdtempSync(join(tmpdir(), "install-cache-"));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFreeReleaseFixture(fixture);
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function deps(fsOverrides: Partial<Parameters<typeof runInstallUseCase>[1]["fs"]> = {}) {
    return {
      fs: {
        mkdirSync,
        writeFileSync,
        existsSync,
        renameSync,
        rmSync,
        ...fsOverrides,
      },
      download: {
        fetchFn: globalThis.fetch.bind(globalThis),
        readFileSync: (path: string) => new Uint8Array(readFileSync(path)),
        writeFileSync: (path: string, data: Uint8Array) => {
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, data);
        },
        mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
        existsSync,
        fixtureDir: fixture,
        cacheDir: cache,
        cliVersion: "0.1.0",
      },
    };
  }

  it("writes managed metadata for free installs", async () => {
    const result = await runInstallUseCase(context(project), deps(), { group: "free" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(project, ".moeicons", "install-metadata.json"))).toBe(true);
    expect(existsSync(join(project, ".moeicons", "catalog.json"))).toBe(true);
    expect(existsSync(join(project, "src", "moeicons", ".moeicons-free.marker"))).toBe(true);
    const metadata = JSON.parse(readFileSync(join(project, ".moeicons", "install-metadata.json"), "utf8")) as {
      tier: string;
      artifactVersion: string;
      artifactSha256: string;
    };
    expect(metadata.tier).toBe("free");
    expect(metadata.artifactVersion).toBe(result.artifactVersion);
    expect(metadata.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.artifactSha256.length).toBe(64);
    expect(readInstalledResourceState(project, "free").kind).toBe("ok");
  });

  it("routes pro/ent away from the free download path", async () => {
    expect(await runInstallUseCase(context(project), deps(), { group: "pro" })).toEqual({
      ok: false,
      reason: "pro-not-implemented",
    });
    expect(await runInstallUseCase(context(project), deps(), { group: "ent" })).toEqual({
      ok: false,
      reason: "pro-not-implemented",
    });
    expect(existsSync(join(project, ".moeicons"))).toBe(false);
  });

  it("rolls back project files when the transactional write fails", async () => {
    let renames = 0;
    const result = await runInstallUseCase(
      context(project),
      deps({
        renameSync: (...args: Parameters<typeof renameSync>) => {
          renames += 1;
          if (renames === 2) throw new Error("simulated rename failure");
          return renameSync(...args);
        },
      }),
      { group: "free" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("write-failed");
    expect(existsSync(join(project, ".moeicons", "install-metadata.json"))).toBe(false);
    expect(existsSync(join(project, "src", "moeicons", ".moeicons-free.marker"))).toBe(false);
  });

  it("honours abort before download", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runInstallUseCase(context(project, controller.signal), deps(), { group: "free" });
    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("rejects version-check/download identity drift before project writes", async () => {
    const result = await runInstallUseCase(context(project), deps(), {
      group: "free", sourceVersion: "0.0.15-alpha", expectedDescriptorSha256: "f".repeat(64),
    });
    expect(result).toMatchObject({ ok: false, reason: "validation" });
    expect(existsSync(join(project, ".moeicons"))).toBe(false);
    expect(existsSync(join(project, "src", "moeicons"))).toBe(false);
  });
});
