import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectCliVersionCheck,
  fetchGithubEvidence,
  parseGithubReleases,
  resetVersionEvidenceCache,
  runCliVersionCheck,
  type VersionSourceEvidence,
} from "../src/core/version-sources.js";

const okNpm = (versions: string[], latest?: string): VersionSourceEvidence => ({
  source: "npm",
  status: "ok",
  checkedAt: "2026-11-18T00:00:00.000Z",
  versions,
  ...(latest ? { latestVersion: latest } : {}),
});

const okGithub = (versions: string[], latest?: string): VersionSourceEvidence => ({
  source: "github",
  status: "ok",
  checkedAt: "2026-11-18T00:00:00.000Z",
  versions,
  ...(latest ? { latestVersion: latest } : {}),
});

const error = (source: "npm" | "github"): VersionSourceEvidence => ({
  source,
  status: "error",
  checkedAt: "2026-11-18T00:00:00.000Z",
  versions: [],
  error: { code: "NETWORK_ERROR", message: "offline" },
});

const unknownSource = { kind: "unknown" as const };

describe("P0-01 dual-source version evidence", () => {
  it("uses npm as the only executable upgrade truth", () => {
    const check = collectCliVersionCheck({
      currentVersion: "1.0.0",
      installSource: { kind: "global", manager: "npm" },
      npm: okNpm(["1.0.0", "1.1.0"], "1.1.0"),
      github: okGithub(["1.0.0"], "1.0.0"),
    });
    expect(check.npmUpdateAvailable).toBe(true);
    expect(check.githubUpdateAvailable).toBe(false);
    expect(check.npmInstruction).toBe("npm install --global @moewolf/moe-icons-cli@1.1.0");
  });

  it("does not fabricate an npm upgrade when only GitHub has a newer release", () => {
    const check = collectCliVersionCheck({
      currentVersion: "1.0.0",
      installSource: { kind: "global", manager: "npm" },
      npm: okNpm(["1.0.0"], "1.0.0"),
      github: okGithub(["1.0.0", "1.2.0"], "1.2.0"),
    });
    expect(check.npmUpdateAvailable).toBe(false);
    expect(check.githubUpdateAvailable).toBe(true);
    expect(check.npmInstruction).toBeUndefined();
    expect(check.githubNote).toContain("GitHub Release v1.2.0");
    expect(check.githubNote).not.toMatch(/npm install/);
  });

  it("shows both sources when the versions conflict", () => {
    const check = collectCliVersionCheck({
      currentVersion: "1.0.0",
      installSource: { kind: "local", manager: "pnpm" },
      npm: okNpm(["1.2.0"], "1.2.0"),
      github: okGithub(["1.1.0"], "1.1.0"),
    });
    expect(check.npm.latestVersion).toBe("1.2.0");
    expect(check.github.latestVersion).toBe("1.1.0");
    expect(check.npmInstruction).toBe("pnpm add --save-exact @moewolf/moe-icons-cli@1.2.0");
  });

  it("never turns a single-source failure into 'up to date'", () => {
    const check = collectCliVersionCheck({
      currentVersion: "1.0.0",
      installSource: unknownSource,
      npm: error("npm"),
      github: okGithub(["1.1.0"], "1.1.0"),
    });
    expect(check.npm.status).toBe("error");
    expect(check.github.status).toBe("ok");
    expect(check.npmUpdateAvailable).toBe(false);
    expect(check.githubUpdateAvailable).toBe(true);
  });

  it("does not guess a package manager for an unknown install source", () => {
    const check = collectCliVersionCheck({
      currentVersion: "1.0.0",
      installSource: unknownSource,
      npm: okNpm(["1.1.0"], "1.1.0"),
      github: okGithub([], undefined),
    });
    expect(check.npmInstruction).toContain("https://moeicons.com/docs/cli-update");
    expect(check.npmInstruction).not.toMatch(/^npm|^pnpm|^yarn/);
  });

  it("ignores drafts and prereleases in GitHub evidence", () => {
    const releases = parseGithubReleases([
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0", prerelease: true, draft: false },
      { tag_name: "v1.2.0", prerelease: false, draft: true },
      { tag_name: "not-a-version", prerelease: false, draft: false },
    ]);
    expect(releases.map((release) => release.version)).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    expect(releases.find((release) => release.version === "1.1.0")?.prerelease).toBe(true);
  });

  it("classifies a rate limit separately from a network error", async () => {
    resetVersionEvidenceCache();
    const evidence = await fetchGithubEvidence({
      fetch: (async () => new Response("{}", { status: 429 })) as typeof fetch,
      env: {},
    });
    expect(evidence.status).toBe("error");
    expect(evidence.error?.code).toBe("RATE_LIMITED");
  });

  it("caches GitHub evidence for the process and can be reset", async () => {
    resetVersionEvidenceCache();
    const fetchFn = vi.fn(async () =>
      Response.json([{ tag_name: "v1.0.0", prerelease: false, draft: false }]),
    );
    const first = await fetchGithubEvidence({ fetch: fetchFn as typeof fetch, env: {} });
    const second = await fetchGithubEvidence({ fetch: fetchFn as typeof fetch, env: {} });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    resetVersionEvidenceCache();
  });

  it("treats missing Release data as unavailable rather than current", async () => {
    resetVersionEvidenceCache();
    const dir = mkdtempSync(join(tmpdir(), "moeicons-cli-version-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
      const check = await runCliVersionCheck({
        currentVersion: "1.0.0",
        cwd: dir,
        env: {},
        fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ name: "fixture" }) },
        fetchVersions: async () => ["1.0.0"],
        fetch: (async () => new Response("bad gateway", { status: 502 })) as typeof fetch,
      });
      expect(check.npm.status).toBe("ok");
      expect(check.github.status).toBe("error");
      expect(check.npmUpdateAvailable).toBe(false);
      expect(check.githubUpdateAvailable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetVersionEvidenceCache();
    }
  });
});
