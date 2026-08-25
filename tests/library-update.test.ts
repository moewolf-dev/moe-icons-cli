import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstallUseCase } from "../src/core/install.js";
import { runLibraryUpdateUseCase } from "../src/core/library-update.js";
import type { CommandContext } from "../src/core/context.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";

const realFs = { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, copyFileSync };
const ui = { select: async () => undefined, confirm: async () => undefined, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) };
function context(cwd: string): CommandContext { return { cwd, env: {}, signal: new AbortController().signal, now: () => new Date("2026-08-24T00:00:00Z"), ui }; }

describe("atomic library update", () => {
  let project: string; let oldFixture: string; let nextFixture: string; let cache: string;
  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), "library-update-")); oldFixture = mkdtempSync(join(tmpdir(), "release-old-"));
    nextFixture = mkdtempSync(join(tmpdir(), "release-next-")); cache = mkdtempSync(join(tmpdir(), "release-cache-"));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", dependencies: {} }));
    const old = writeFreeReleaseFixture(oldFixture);
    await runInstallUseCase(context(project), { fs: realFs, download: download(oldFixture) }, { group: "free", sourceVersion: old.version });
    writeFileSync(join(project, "moeicons.config.json"), JSON.stringify({ schemaVersion: 1, tier: "free", framework: "react", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } }, icons: ["ui-search"] }));
  });
  afterEach(() => { for (const path of [project, oldFixture, nextFixture, cache]) rmSync(path, { recursive: true, force: true }); });
  function download(fixtureDir: string) { return { fetchFn: globalThis.fetch.bind(globalThis), readFileSync: (path: string) => new Uint8Array(readFileSync(path)), writeFileSync: (path: string, data: Uint8Array) => writeFileSync(path, data), mkdirSync: (path: string) => mkdirSync(path, { recursive: true }), existsSync, fixtureDir, cacheDir: cache, cliVersion: "0.1.0" }; }
  function deps(fixtureDir: string, fs = realFs) { return { fs, free: download(fixtureDir), auth: {} }; }

  it("commits candidate catalog, generated files and metadata together", async () => {
    const next = writeFreeReleaseFixture(nextFixture, { version: "0.0.18", useBundledCatalog: true });
    const result = await runLibraryUpdateUseCase(context(project), deps(nextFixture), { tier: "free", version: next.version, descriptorSha256: next.descriptorSha });
    expect(result.artifactVersion).toBe("0.0.18");
    expect(existsSync(join(project, "src/moeicons/icons/UiSearch.tsx"))).toBe(true);
    expect(JSON.parse(readFileSync(join(project, ".moeicons/install-metadata.json"), "utf8")).artifactVersion).toBe("0.0.18");
  });

  it("keeps the old installation byte-for-byte when commit fails", async () => {
    const next = writeFreeReleaseFixture(nextFixture, { version: "0.0.18", useBundledCatalog: true });
    const before = readFileSync(join(project, ".moeicons/install-metadata.json"), "utf8");
    let renames = 0;
    await expect(runLibraryUpdateUseCase(context(project), deps(nextFixture, { ...realFs, renameSync: (...args: Parameters<typeof renameSync>) => { if (++renames === 5) throw new Error("commit failed"); return renameSync(...args); } }), { tier: "free", version: next.version, descriptorSha256: next.descriptorSha })).rejects.toThrow("commit failed");
    expect(readFileSync(join(project, ".moeicons/install-metadata.json"), "utf8")).toBe(before);
    expect(existsSync(join(project, "src/moeicons/icons/UiSearch.tsx"))).toBe(false);
  });
});
