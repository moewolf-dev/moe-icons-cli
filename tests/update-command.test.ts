import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/commands/parser.js";
import { main } from "../src/cli.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";
import { runInstallUseCase } from "../src/core/install.js";
import type { CommandContext } from "../src/core/context.js";

describe("update command parsing (MC.7)", () => {
  it("parses `update metadata` as metadata-only", () => {
    expect(parseArgs(["update", "metadata"])).toMatchObject({ command: { name: "update", metadata: true } });
  });
  it("parses bare `update` as full update", () => {
    expect(parseArgs(["update"])).toMatchObject({ command: { name: "update", metadata: false } });
  });
  it("keeps --json in the parse result", () => {
    expect(parseArgs(["update", "metadata", "--json"]).json).toBe(true);
  });
});

describe("`moeicons update metadata` CLI path", () => {
  let project: string;
  let release: string;
  let cache: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "update-cmd-"));
    release = mkdtempSync(join(tmpdir(), "update-cmd-release-"));
    cache = mkdtempSync(join(tmpdir(), "update-cmd-cache-"));
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "u", version: "1.0.0" }));
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

  function context(dir: string): CommandContext {
    return {
      cwd: dir,
      env: { MOEICONS_CACHE_DIR: cache, MOEICONS_FREE_RELEASE_DIR: release },
      signal: new AbortController().signal,
      now: () => new Date(),
      ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
    };
  }

  function runtime(dir: string) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      runtime: {
        cwd: () => dir,
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
        env: { MOEICONS_CACHE_DIR: cache, MOEICONS_FREE_RELEASE_DIR: release },
        isTTY: () => false,
      },
      out,
      err,
    };
  }

  it("syncs metadata for an installed free project", async () => {
    const installed = await runInstallUseCase(context(project), { fs: { mkdirSync, writeFileSync, existsSync, renameSync, rmSync }, download: freeDeps() }, {});
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    rmSync(join(project, ".moeicons", "MANUAL.md"), { force: true });
    rmSync(join(project, ".moeicons", "manifest.json"), { force: true });

    const { runtime: rt, out } = runtime(project);
    const code = await main(["update", "metadata", "--json"], rt);
    expect(code).toBe(0);
    const body = JSON.parse(out.join(""));
    expect(body).toMatchObject({ ok: true, tier: "free", artifactVersion: installed.artifactVersion });
    expect(body.files).toEqual([".moeicons/MANUAL.md", ".moeicons/catalog.json", ".moeicons/manifest.json"]);
    expect(existsSync(join(project, ".moeicons", "MANUAL.md"))).toBe(true);
    expect(existsSync(join(project, ".moeicons", "manifest.json"))).toBe(true);
  });

  it("fails with validation error when nothing is installed", async () => {
    const { runtime: rt, err } = runtime(project);
    const code = await main(["update", "metadata"], rt);
    expect(code).toBe(1);
    expect(err.join("")).toContain("managed install metadata is missing");
  });
});
