import { describe, expect, it, vi } from "vitest";
import { fetchLibraryVersions, fetchMoeiconsVersions, latestInChannel } from "../src/core/version-service.js";
import { detectInstallSource, detectLocalInstall, fixedUpdateInstruction, planCliUpdate, runCliUpdateCheck } from "../src/core/cli-update.js";

describe("fixed-host version checks", () => {
  it("queries only the public library endpoint without project or auth data", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => Response.json({
      schemaVersion: 1,
      free: { version: "0.0.15-alpha", releasedAt: "2026-08-24T00:00:00Z", descriptorSha256: "a".repeat(64) },
      pro: null,
    }));
    await expect(fetchLibraryVersions({ fetch: fetchFn })).resolves.toMatchObject({ schemaVersion: 1, pro: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.moeicons.com/v1/icon-library/versions");
    expect(options?.headers).toEqual({ accept: "application/json" });
    expect(JSON.stringify(options)).not.toMatch(/authorization|cookie|project|icon/i);
  });

  it("supports AbortSignal and rejects malformed responses", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchLibraryVersions({ signal: controller.signal, fetch: vi.fn(async (_url, options) => {
      if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return Response.json({});
    }) })).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(fetchLibraryVersions({ fetch: vi.fn(async () => Response.json({ schemaVersion: 1, free: { version: "latest" }, pro: null })) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("bounds a stalled registry check with its timeout", async () => {
    const stalled = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    await expect(fetchMoeiconsVersions({ fetch: stalled as typeof fetch, timeoutMs: 1 })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("selects the latest CLI version only within the running prerelease channel", async () => {
    const versions = await fetchMoeiconsVersions({ fetch: vi.fn(async () => Response.json({ versions: { "1.0.0": {}, "1.1.0": {}, "2.0.0-alpha": {}, latest: {} } })) });
    expect(latestInChannel("1.0.0", versions)).toBe("1.1.0");
    expect(latestInChannel("1.0.0-alpha", versions)).toBe("2.0.0-alpha");
  });
});

describe("read-only CLI update instructions", () => {
  it("detects local/global/npx/unknown sources", () => {
    expect(detectInstallSource({ env: {}, localDependency: true, localManager: "pnpm" })).toEqual({ kind: "local", manager: "pnpm" });
    expect(detectInstallSource({ env: { npm_config_global: "true", npm_config_user_agent: "yarn/1.22" } })).toEqual({ kind: "global", manager: "yarn" });
    expect(detectInstallSource({ env: { npm_command: "exec" } })).toEqual({ kind: "npx" });
    expect(detectInstallSource({ env: {} })).toEqual({ kind: "unknown" });
  });

  it("emits fixed-version commands and never latest", () => {
    const sources = [
      { kind: "local", manager: "npm" }, { kind: "local", manager: "pnpm" }, { kind: "local", manager: "yarn" },
      { kind: "global", manager: "npm" }, { kind: "global", manager: "pnpm" }, { kind: "global", manager: "yarn" },
      { kind: "npx" }, { kind: "unknown" },
    ] as const;
    for (const source of sources) {
      const instruction = fixedUpdateInstruction(source, "1.2.3");
       expect(instruction).toContain("@moewolf/moe-icons-cli@1.2.3");
      expect(instruction).not.toContain("latest");
    }
    expect(planCliUpdate("1.0.0", ["1.0.0", "1.1.0", "2.0.0-alpha"], { kind: "npx" })).toEqual({
       status: "update", currentVersion: "1.0.0", latestVersion: "1.1.0", instruction: "npx --yes @moewolf/moe-icons-cli@1.1.0",
    });
  });

  it("detects a project-local dependency from its lockfile and remains read-only", async () => {
    const reads: string[] = [];
    const fs = {
       readFileSync(path: string) { reads.push(path); return JSON.stringify({ devDependencies: { "@moewolf/moe-icons-cli": "0.1.0" } }); },
      existsSync(path: string) { reads.push(path); return path.endsWith("pnpm-lock.yaml"); },
    };
    expect(detectLocalInstall("/project", fs)).toEqual({ localDependency: true, localManager: "pnpm" });
    const result = await runCliUpdateCheck({ currentVersion: "0.1.0", cwd: "/project", env: {}, fs, fetchVersions: async () => ["0.1.0", "0.1.1"] });
     expect(result).toMatchObject({ status: "update", latestVersion: "0.1.1", source: { kind: "local", manager: "pnpm" }, instruction: "pnpm add --save-exact @moewolf/moe-icons-cli@0.1.1" });
    expect(reads.every((path) => path.startsWith("/project/"))).toBe(true);
  });

  it("does not downgrade and keeps prerelease channels separate", async () => {
    const fs = { readFileSync: () => { throw new Error("absent"); }, existsSync: () => false };
    await expect(runCliUpdateCheck({ currentVersion: "2.0.0", cwd: "/p", env: {}, fs, fetchVersions: async () => ["1.9.9"] })).resolves.toMatchObject({ status: "current", latestVersion: "1.9.9" });
     await expect(runCliUpdateCheck({ currentVersion: "1.0.0-alpha", cwd: "/p", env: { npm_command: "exec" }, fs, fetchVersions: async () => ["9.0.0", "1.0.1-alpha"] })).resolves.toMatchObject({ status: "update", instruction: "npx --yes @moewolf/moe-icons-cli@1.0.1-alpha" });
  });
});
