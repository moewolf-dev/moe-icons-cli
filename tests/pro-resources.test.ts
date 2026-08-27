import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { proResourceState, runProPredownloadUseCase } from "../src/core/pro-resources.js";
import { artifactCachePath, metadataCachePath } from "../src/core/free-download.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";
import type { CommandContext } from "../src/core/context.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";

const DESCRIPTOR_SHA = "a".repeat(64);
const session: StoredSession = {
  accountId: "auth0|pro",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.parse("2099-08-24T00:00:00Z"),
  scope: "openid",
  storedAt: 1,
};
function tokenStore(): TokenStore {
  return { get: () => session, getActive: () => session, set() {}, delete() {}, clear() {} };
}
function context(cacheDir: string): CommandContext {
  return {
    cwd: cacheDir,
    env: { MOEICONS_CACHE_DIR: cacheDir },
    signal: new AbortController().signal,
    now: () => new Date("2026-08-24T00:00:00Z"),
    ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
  };
}

describe("pro resource state and pre-download (ME.2-ME.5)", () => {
  let release: string;
  let cache: string;
  let meta: ReturnType<typeof writeFreeReleaseFixture>;
  let codeBytes: Uint8Array;
  let metaBytes: Uint8Array;

  beforeEach(() => {
    release = mkdtempSync(join(tmpdir(), "pro-res-"));
    cache = mkdtempSync(join(tmpdir(), "pro-res-cache-"));
    meta = writeFreeReleaseFixture(release, { tier: "pro" });
    codeBytes = new Uint8Array(readFileSync(join(release, meta.freeName)));
    metaBytes = new Uint8Array(readFileSync(join(release, meta.metadataName)));
  });
  afterEach(() => {
    rmSync(release, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function descriptor() {
    return {
      ok: true,
      tier: "pro",
      version: meta.version,
      descriptorSha256: DESCRIPTOR_SHA,
      catalogFilename: "catalog.json",
      catalogSha256: meta.catalogSha,
      url: "https://signed.example/pro.tgz",
      expiresAt: "2099-01-01T00:00:00Z",
      size: codeBytes.byteLength,
      sha256: meta.freeSha,
      metadata: { url: "https://signed.example/pro-meta.tgz", expiresAt: "2099-01-01T00:00:00Z", size: metaBytes.byteLength, sha256: meta.metadataSha },
    };
  }

  function fetchFn(authAssert: (init: RequestInit | undefined) => void = () => undefined) {
    return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/icon-library/versions")) {
        return Response.json({ schemaVersion: 1, free: null, pro: { version: meta.version, releasedAt: "2026-08-24T00:00:00Z", descriptorSha256: DESCRIPTOR_SHA } });
      }
      if (url.includes("artifact-descriptor")) {
        authAssert(init);
        return Response.json(descriptor());
      }
      authAssert(init);
      return new Response(url.includes("pro-meta") ? metaBytes : codeBytes);
    };
  }

  it("reports not-cached when nothing is in the cache", async () => {
    const state = await proResourceState(context(cache), { tokenStore: tokenStore() }, { fetch: fetchFn() as typeof fetch, allowedProHosts: ["signed.example"] });
    expect(state.kind).toBe("not-cached");
    if (state.kind === "not-cached") {
      expect(state.version).toBe(meta.version);
      expect(state.codeBytes).toBe(codeBytes.byteLength);
      expect(state.metadataBytes).toBe(metaBytes.byteLength);
    }
  });

  it("reports current when the latest archives are cached and verified", async () => {
    const codePath = artifactCachePath(cache, meta.version, meta.freeSha);
    const metaPath = metadataCachePath(cache, meta.version, meta.metadataSha);
    mkdirSync(join(codePath, ".."), { recursive: true });
    mkdirSync(join(metaPath, ".."), { recursive: true });
    writeFileSync(codePath, codeBytes);
    writeFileSync(metaPath, metaBytes);
    const state = await proResourceState(context(cache), { tokenStore: tokenStore() }, { fetch: fetchFn() as typeof fetch, allowedProHosts: ["signed.example"] });
    expect(state.kind).toBe("current");
  });

  it("reports corrupt when cached bytes fail verification", async () => {
    const codePath = artifactCachePath(cache, meta.version, meta.freeSha);
    const metaPath = metadataCachePath(cache, meta.version, meta.metadataSha);
    mkdirSync(join(codePath, ".."), { recursive: true });
    mkdirSync(join(metaPath, ".."), { recursive: true });
    writeFileSync(codePath, Buffer.from("corrupt"));
    writeFileSync(metaPath, metaBytes);
    const state = await proResourceState(context(cache), { tokenStore: tokenStore() }, { fetch: fetchFn() as typeof fetch, allowedProHosts: ["signed.example"] });
    expect(state.kind).toBe("corrupt");
  });

  it("pre-downloads and caches code + metadata without installing", async () => {
    const result = await runProPredownloadUseCase(
      context(cache),
      { tokenStore: tokenStore() },
      { fetch: fetchFn() as typeof fetch, allowedProHosts: ["signed.example"] },
    );
    expect(result.version).toBe(meta.version);
    expect(result.codeSha256).toBe(meta.freeSha);
    expect(result.metadataSha256).toBe(meta.metadataSha);
    expect(existsSync(artifactCachePath(cache, meta.version, meta.freeSha))).toBe(true);
    expect(existsSync(metadataCachePath(cache, meta.version, meta.metadataSha))).toBe(true);
  });

  it("forces a re-download when repair is requested", async () => {
    const codePath = artifactCachePath(cache, meta.version, meta.freeSha);
    mkdirSync(join(codePath, ".."), { recursive: true });
    writeFileSync(codePath, Buffer.from("corrupt"));
    await runProPredownloadUseCase(
      context(cache),
      { tokenStore: tokenStore() },
      { fetch: fetchFn() as typeof fetch, allowedProHosts: ["signed.example"], force: true },
    );
    expect(readFileSync(codePath).equals(Buffer.from(codeBytes))).toBe(true);
  });
});
