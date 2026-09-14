import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLibraryVersions } from "../src/core/version-service.js";
import { allowLocalTestFromEnv, isLoopbackHttpUrl, resolveLocalTestContext } from "../src/core/local-test-env.js";
import { downloadProArtifact } from "../src/core/pro-download.js";
import {
  parseInstallMetadata,
  sha256Bytes,
  type InstallMetadata,
} from "../src/project/install-metadata.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";
import type { CommandContext } from "../src/core/context.js";
import { loadInstalledCatalogState } from "../src/core/generate.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";

const LOOPBACK_VERSIONS = "http://127.0.0.1:1/v1/icon-library/versions";
const LOOPBACK_DESCRIPTOR = "http://127.0.0.1:1/v1/icon-library/pro/artifact-descriptor";
const LOCAL_ENV: Record<string, string> = {
  MOEICONS_ENV: "local",
  MOEICONS_LIBRARY_VERSIONS_URL: LOOPBACK_VERSIONS,
  MOEICONS_PRO_DESCRIPTOR_URL: LOOPBACK_DESCRIPTOR,
};
const TEST_VERSION = "0.0.15-test";
const SHA = "a".repeat(64);

function store(session: StoredSession): TokenStore {
  return { get: () => session, getActive: () => session, set() {}, delete() {}, clear() {} };
}
const SESSION: StoredSession = {
  accountId: "auth0|fixture",
  accessToken: "access-fixture",
  refreshToken: "refresh-fixture",
  expiresAt: Date.parse("2099-01-01T00:00:00Z"),
  scope: "openid",
  storedAt: 1,
};
function context(dir: string, env: Record<string, string> = {}): CommandContext {
  return {
    cwd: dir,
    env,
    signal: new AbortController().signal,
    now: () => new Date("2026-08-24T00:00:00Z"),
    ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
  };
}

function versionsResponse(extra: Record<string, unknown>) {
  return Response.json({ schemaVersion: 1, free: null, pro: { version: TEST_VERSION, releasedAt: "2026-08-24T00:00:00Z", descriptorSha256: SHA, ...extra } });
}

describe("A-1b local-test context gate (fail closed)", () => {
  it("accepts only MOEICONS_ENV=local with BOTH endpoints loopback HTTP", () => {
    expect(resolveLocalTestContext(LOCAL_ENV)).toEqual({ allowLocalTest: true });
  });

  it("rejects production endpoints, a missing env flag and half-loopback setups (cases 1/2/3/6)", () => {
    expect(resolveLocalTestContext({})).toEqual({ allowLocalTest: false });
    expect(resolveLocalTestContext({ ...LOCAL_ENV, MOEICONS_ENV: "production" })).toEqual({ allowLocalTest: false });
    expect(resolveLocalTestContext({ MOEICONS_LIBRARY_VERSIONS_URL: LOOPBACK_VERSIONS, MOEICONS_PRO_DESCRIPTOR_URL: LOOPBACK_DESCRIPTOR })).toEqual({ allowLocalTest: false });
    expect(resolveLocalTestContext({ ...LOCAL_ENV, MOEICONS_LIBRARY_VERSIONS_URL: undefined })).toEqual({ allowLocalTest: false });
    expect(resolveLocalTestContext({ ...LOCAL_ENV, MOEICONS_PRO_DESCRIPTOR_URL: undefined })).toEqual({ allowLocalTest: false });
  });

  it("grants the read-side allowance only for the local Pro seam or a free fixture dir", () => {
    expect(allowLocalTestFromEnv(LOCAL_ENV)).toBe(true);
    expect(allowLocalTestFromEnv({ MOEICONS_FREE_RELEASE_DIR: "/tmp/release" })).toBe(true);
    expect(allowLocalTestFromEnv({})).toBe(false);
    expect(allowLocalTestFromEnv({ MOEICONS_ENV: "production" })).toBe(false);
  });

  it("classifies loopback urls strictly", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:8787/x")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:1/x")).toBe(true);
    expect(isLoopbackHttpUrl("https://127.0.0.1/x")).toBe(false);
    expect(isLoopbackHttpUrl("https://api.moeicons.com/x")).toBe(false);
    expect(isLoopbackHttpUrl("not a url")).toBe(false);
  });
});

describe("A-1b version service", () => {
  it("rejects a -test version without the local seam (case 1)", async () => {
    await expect(
      fetchLibraryVersions({ fetch: vi.fn(async () => versionsResponse({ channel: "local-test", publishable: false })) }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("accepts a declared local-test version only when allowLocalTest is on (cases 4/5)", async () => {
    const ok = await fetchLibraryVersions({ allowLocalTest: true, fetch: vi.fn(async () => versionsResponse({ channel: "local-test", publishable: false })) });
    expect(ok.pro).toMatchObject({ version: TEST_VERSION, channel: "local-test", publishable: false });
    for (const extra of [{ publishable: false }, { channel: "local-test" }, { channel: "local-test", publishable: true }]) {
      await expect(fetchLibraryVersions({ allowLocalTest: true, fetch: vi.fn(async () => versionsResponse(extra)) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("keeps stable/alpha/beta behavior unchanged (case 7)", async () => {
    for (const version of ["0.0.15", "0.0.15-alpha", "0.0.15-beta"]) {
      const result = await fetchLibraryVersions({ fetch: vi.fn(async () => Response.json({ schemaVersion: 1, free: null, pro: { version, releasedAt: "2026-08-24T00:00:00Z", descriptorSha256: SHA } })) });
      expect(result.pro?.version).toBe(version);
    }
  });

  it("rejects a formal version that carries the local-test marker (contract tightening)", async () => {
    await expect(fetchLibraryVersions({ allowLocalTest: true, fetch: vi.fn(async () => Response.json({ schemaVersion: 1, free: null, pro: { version: "0.0.15", releasedAt: "2026-08-24T00:00:00Z", descriptorSha256: SHA, channel: "local-test", publishable: false } })) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("A-1b pro descriptor", () => {
  let release: string;
  beforeEach(() => {
    release = mkdtempSync(join(tmpdir(), "pro-local-test-"));
  });
  afterEach(() => rmSync(release, { recursive: true, force: true }));

  function fixture() {
    const meta = writeFreeReleaseFixture(release, { tier: "pro", version: TEST_VERSION, localTest: true });
    const archive = new Uint8Array(readFileSync(join(release, meta.freeName)));
    const metadataArchive = new Uint8Array(readFileSync(join(release, meta.metadataName)));
    return { meta, archive, metadataArchive };
  }
  function descriptorBody(f: ReturnType<typeof fixture>, overrides: Record<string, unknown>) {
    return {
      ok: true, tier: "pro", version: TEST_VERSION, descriptorSha256: f.meta.descriptorSha,
      catalogFilename: "catalog.json", catalogSha256: f.meta.catalogSha,
      url: "https://signed.example/object", expiresAt: "2099-01-01T00:00:00Z",
      size: f.archive.byteLength, sha256: f.meta.freeSha,
      channel: "local-test", publishable: false,
      metadata: { url: "https://signed.example/meta", expiresAt: "2099-01-01T00:00:00Z", size: f.metadataArchive.byteLength, sha256: f.meta.metadataSha },
      ...overrides,
    };
  }
  function fetchFor(body: unknown, archive: Uint8Array, metadataArchive: Uint8Array) {
    return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("artifact-descriptor")) return Response.json(body);
      return url.includes("/meta") ? new Response(metadataArchive) : new Response(archive);
    });
  }

  it("installs a declared local-test candidate only with allowLocalTest (cases 1/4/5)", async () => {
    const f = fixture();
    const ok = await downloadProArtifact(
      context(release, LOCAL_ENV),
      { tokenStore: store(SESSION) },
      { version: TEST_VERSION, descriptorSha256: f.meta.descriptorSha, allowLocalTest: true },
      { fetch: fetchFor(descriptorBody(f, {}), f.archive, f.metadataArchive) as typeof fetch, allowedHosts: ["signed.example"] },
    );
    expect(ok.descriptor.channel).toBe("local-test");
    expect(ok.manifestJson).toContain('"tier": "pro"');

    const bodies = [descriptorBody(f, { channel: undefined }), descriptorBody(f, { publishable: true })];
    for (const body of bodies) {
      await expect(downloadProArtifact(
        context(release, LOCAL_ENV),
        { tokenStore: store(SESSION) },
        { version: TEST_VERSION, descriptorSha256: f.meta.descriptorSha, allowLocalTest: true },
        { fetch: fetchFor(body, f.archive, f.metadataArchive) as typeof fetch, allowedHosts: ["signed.example"] },
      )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(downloadProArtifact(
      context(release, LOCAL_ENV),
      { tokenStore: store(SESSION) },
      { version: TEST_VERSION, descriptorSha256: f.meta.descriptorSha },
      { fetch: fetchFor(descriptorBody(f, {}), f.archive, f.metadataArchive) as typeof fetch, allowedHosts: ["signed.example"] },
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a tampered local-test code archive (case 8)", async () => {
    const f = fixture();
    const tampered = new Uint8Array(f.archive);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    await expect(downloadProArtifact(
      context(release, LOCAL_ENV),
      { tokenStore: store(SESSION) },
      { version: TEST_VERSION, descriptorSha256: f.meta.descriptorSha, allowLocalTest: true },
      { fetch: fetchFor(descriptorBody(f, {}), tampered, f.metadataArchive) as typeof fetch, allowedHosts: ["signed.example"] },
    )).rejects.toBeTruthy();
  });

  it("rejects a formal version that carries the local-test marker (contract tightening)", async () => {
    const version = "0.0.15";
    const meta = writeFreeReleaseFixture(release, { tier: "pro", version });
    const archive = new Uint8Array(readFileSync(join(release, meta.freeName)));
    const metadataArchive = new Uint8Array(readFileSync(join(release, meta.metadataName)));
    const f = { meta, archive, metadataArchive };
    const body = { ...descriptorBody(f, {}), version, descriptorSha256: meta.descriptorSha, channel: "local-test", publishable: false };
    await expect(downloadProArtifact(
      context(release, LOCAL_ENV),
      { tokenStore: store(SESSION) },
      { version, descriptorSha256: meta.descriptorSha, allowLocalTest: true },
      { fetch: fetchFor(body, archive, metadataArchive) as typeof fetch, allowedHosts: ["signed.example"] },
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("A-1b install metadata", () => {
  function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const catalog = '{"schemaVersion":1}\n';
    return {
      schemaVersion: 1,
      artifactVersion: TEST_VERSION,
      tier: "pro",
      target: "react",
      descriptorSha256: SHA,
      artifactSha256: "b".repeat(64),
      catalogSha256: sha256Bytes(catalog),
      installedAt: "2026-08-24T00:00:00.000Z",
      managedFiles: { ".moeicons/catalog.json": sha256Bytes(catalog) },
      channel: "local-test",
      publishable: false,
      ...overrides,
    };
  }

  it("accepts a declared local-test install only with allowLocalTest (cases 4/5)", () => {
    const parsed = parseInstallMetadata(JSON.stringify(metadata()), { allowLocalTest: true }) as InstallMetadata | undefined;
    expect(parsed).toMatchObject({ channel: "local-test", publishable: false });
    expect(parseInstallMetadata(JSON.stringify(metadata()), {})).toBeUndefined();
    const noChannel = metadata();
    delete noChannel.channel;
    expect(parseInstallMetadata(JSON.stringify(noChannel), { allowLocalTest: true })).toBeUndefined();
    expect(parseInstallMetadata(JSON.stringify(metadata({ publishable: true })), { allowLocalTest: true })).toBeUndefined();
  });

  it("rejects a formal version that carries the local-test marker (contract tightening)", () => {
    expect(parseInstallMetadata(JSON.stringify(metadata({ artifactVersion: "0.0.15" })), { allowLocalTest: true })).toBeUndefined();
  });

  it("still rejects a bare catalog without install metadata even under local-test (case 9)", () => {
    const root = mkdtempSync(join(tmpdir(), "moeicons-bare-catalog-"));
    try {
      mkdirSync(join(root, ".moeicons"), { recursive: true });
      const sourceCommit = "a".repeat(40);
      const generatorCommit = "b".repeat(40);
      writeFileSync(join(root, ".moeicons", "catalog.json"), `${JSON.stringify({ schemaVersion: 1, catalogVersion: "0.0.15", sourceVersion: "0.0.15", sourceCommit, generatorCommit, styleGroups: [], icons: [] })}\n`);
      const fs_ = { readFileSync, existsSync };
      expect(loadInstalledCatalogState(root, fs_, { allowLocalTest: true })).toMatchObject({ status: "invalid", message: expect.stringContaining("without install metadata") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
