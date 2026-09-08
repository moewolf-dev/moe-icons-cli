import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { downloadFreeRelease, bundledSourceVersion } from "../src/core/free-download.js";
import { assertLocalCandidateAllowed, githubReleaseAssetUrl, isLocalTestVersion, parseReleaseDescriptor, PUBLIC_FREE_REPO } from "../src/core/release-descriptor.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";
import { downloadArtifact } from "../src/project/install.js";
import { createTarGz, extractTarGz } from "../src/project/tar-gz.js";
import { createServer, type Server } from "node:http";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("tar-gz roundtrip", () => {
  it("packs and unpacks catalog.json", () => {
    const packed = createTarGz({ "catalog.json": "{\"ok\":true}\n" });
    const unpacked = extractTarGz(packed, { maxEntries: 10, maxExpandedBytes: 1024 });
    expect(unpacked.errors).toEqual([]);
    expect(Buffer.from(unpacked.files["catalog.json"] ?? []).toString("utf8")).toBe('{"ok":true}\n');
  });
});

describe("release descriptor", () => {
  it("never invents free.filename", () => {
    const json = Buffer.from(
      JSON.stringify({
        fullVersion: "0.0.17",
        free: { filename: "moe-icons-free-0.0.17.tgz", sha256: "a".repeat(64) },
        catalog: { filename: "catalog.json", sha256: "b".repeat(64), schemaVersion: 1 },
      }),
    );
    expect(parseReleaseDescriptor(json).free.filename).toBe("moe-icons-free-0.0.17.tgz");
    expect(() =>
      parseReleaseDescriptor(
        Buffer.from(
          JSON.stringify({
            fullVersion: "0.0.17",
            free: { filename: "../escape.tgz", sha256: "a".repeat(64) },
            catalog: { filename: "catalog.json", sha256: "b".repeat(64), schemaVersion: 1 },
          }),
        ),
      ),
    ).toThrow(/basename/);
  });

  it("builds GitHub release asset URLs for the public free repo", () => {
    expect(githubReleaseAssetUrl("v0.0.17", "release-descriptor.json")).toBe(
      `https://github.com/${PUBLIC_FREE_REPO.owner}/${PUBLIC_FREE_REPO.name}/releases/download/v0.0.17/release-descriptor.json`,
    );
  });
});

describe("local-test candidate descriptor guard (E2E-E3)", () => {
  const localTestDescriptor = {
    schemaVersion: 2,
    channel: "local-test",
    publishable: false,
    baseVersion: "0.0.15",
    fullVersion: "0.0.15-test",
    free: { filename: "moe-icons-free-0.0.15-test.tgz", sha256: "a".repeat(64) },
    catalog: { filename: "catalog.json", sha256: "b".repeat(64), schemaVersion: 1 },
  };

  it("accepts a fully-marked local-test descriptor only from a local fixture", () => {
    expect(isLocalTestVersion("0.0.15-test")).toBe(true);
    const parsed = parseReleaseDescriptor(Buffer.from(JSON.stringify(localTestDescriptor)));
    expect(parsed.channel).toBe("local-test");
    expect(parsed.publishable).toBe(false);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.baseVersion).toBe("0.0.15");
    expect(() => assertLocalCandidateAllowed(parsed, true)).not.toThrow();
  });

  it("rejects a local-test descriptor from a remote/HTTP source", () => {
    const parsed = parseReleaseDescriptor(Buffer.from(JSON.stringify(localTestDescriptor)));
    expect(() => assertLocalCandidateAllowed(parsed, false)).toThrow(/local release directory/);
  });

  it("rejects local-test descriptors missing the local-test channel", () => {
    const withoutChannel = parseReleaseDescriptor(
      Buffer.from(
        JSON.stringify({
          ...localTestDescriptor,
          schemaVersion: 2,
          channel: undefined,
          publishable: false,
        }),
      ),
    );
    expect(() => assertLocalCandidateAllowed(withoutChannel, true)).toThrow(/channel local-test/);
  });

  it("rejects local-test descriptors that are publishable", () => {
    const publishable = parseReleaseDescriptor(
      Buffer.from(
        JSON.stringify({ ...localTestDescriptor, channel: "local-test", publishable: true }),
      ),
    );
    expect(() => assertLocalCandidateAllowed(publishable, true)).toThrow(/publishable: false/);
  });

  it("leaves stable production descriptors unconstrained", () => {
    const stable = parseReleaseDescriptor(
      Buffer.from(
        JSON.stringify({
          fullVersion: "0.0.17",
          free: { filename: "moe-icons-free-0.0.17.tgz", sha256: "a".repeat(64) },
          catalog: { filename: "catalog.json", sha256: "b".repeat(64), schemaVersion: 1 },
        }),
      ),
    );
    expect(() => assertLocalCandidateAllowed(stable, false)).not.toThrow();
  });

  it("rejects local-test fullVersion that is schema-invalid or missing schemaVersion 2", async () => {
    const badSchema = parseReleaseDescriptor(
      Buffer.from(JSON.stringify({ ...localTestDescriptor, schemaVersion: 1 })),
    );
    expect(() => assertLocalCandidateAllowed(badSchema, true)).toThrow(/schemaVersion 2/);

    const wrongBase = parseReleaseDescriptor(
      Buffer.from(JSON.stringify({ ...localTestDescriptor, baseVersion: "9.9.9" })),
    );
    expect(() => assertLocalCandidateAllowed(wrongBase, true)).toThrow(/baseVersion/);
  });

  it("downloadFreeRelease accepts a fully-marked local-test descriptor from a local fixture dir", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "free-release-"));
    const cache = mkdtempSync(join(tmpdir(), "free-cache-"));
    try {
      const meta = writeFreeReleaseFixture(fixture, { localTest: true, version: "0.0.15-test" });
      const result = await downloadFreeRelease(
        {
          fetchFn: globalThis.fetch.bind(globalThis),
          readFileSync: (p: string) => new Uint8Array(readFileSync(p)),
          writeFileSync: (p: string, d: Uint8Array) => {
            mkdirSync(join(p, ".."), { recursive: true });
            writeFileSync(p, d);
          },
          mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
          existsSync,
          renameSync,
          rmSync,
          fixtureDir: fixture,
          cacheDir: cache,
          cliVersion: "0.1.0",
          signal: new AbortController().signal,
        },
        meta.version,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.descriptor.fullVersion).toBe("0.0.15-test");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("downloadFreeRelease rejects a -test descriptor served over remote HTTP (no local fixture)", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "free-release-"));
    const cache = mkdtempSync(join(tmpdir(), "free-cache-"));
    const server = createServer((request, response) => {
      const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
      try {
        response.end(readFileSync(join(fixture, name)));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
    try {
      const meta = writeFreeReleaseFixture(fixture, { localTest: true, version: "0.0.15-test" });
      const base = {
        fetchFn: globalThis.fetch.bind(globalThis),
        readFileSync: (p: string) => new Uint8Array(readFileSync(p)),
        writeFileSync: (p: string, d: Uint8Array) => {
          mkdirSync(join(p, ".."), { recursive: true });
          writeFileSync(p, d);
        },
        mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
        existsSync,
        renameSync,
        rmSync,
        cacheDir: cache,
        cliVersion: "0.1.0",
        signal: new AbortController().signal,
      };
      // Served over plain HTTP without a local fixtureDir => must be rejected as validation.
      const result = await downloadFreeRelease(
        { ...base, fixtureBaseUrl: `http://127.0.0.1:${address.port}` },
        meta.version,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("validation");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });
});

describe("downloadArtifact redirect host policy", () => {
  it("rejects redirects to hosts outside the allowlist", async () => {
    const result = await downloadArtifact(
      "https://github.com/moewolf-dev/moe-icons/releases/download/v0.0.17/start",
      {
        maxBytes: 1024,
        timeoutMs: 5000,
        maxRedirects: 3,
        allowedHosts: ["github.com", "objects.githubusercontent.com"],
      },
      {
        fetchFn: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example.com/g.zip" } }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HOST_NOT_ALLOWED");
  });
});

describe("downloadFreeRelease", () => {
  let fixture: string;
  let cache: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "free-release-"));
    cache = mkdtempSync(join(tmpdir(), "free-cache-"));
  });
  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function io(overrides: { fixtureDir?: string; signal?: AbortSignal } = {}) {
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
      fixtureDir: overrides.fixtureDir ?? fixture,
      cacheDir: cache,
      cliVersion: "0.1.0",
      signal: overrides.signal ?? new AbortController().signal,
    };
  }

  it("installs free from a local release fixture and caches the artifact", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    const first = await downloadFreeRelease(io(), meta.version);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cacheHit).toBe(false);
    expect(first.descriptorSha256).toBe(meta.descriptorSha);
    expect(sha256(first.artifactBytes)).toBe(meta.freeSha);

    const second = await downloadFreeRelease(io(), meta.version);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cacheHit).toBe(true);
  });

  it("rejects a corrupted free artifact checksum before caching", async () => {
    const meta = writeFreeReleaseFixture(fixture, { corruptArtifact: true });
    const result = await downloadFreeRelease(io(), meta.version);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("checksum-mismatch");
    expect(existsSync(join(cache, "moewolf-dev"))).toBe(false);
  });

  it("rejects a descriptor sidecar checksum mismatch", async () => {
    const meta = writeFreeReleaseFixture(fixture, { wrongDescriptorSha: true });
    const result = await downloadFreeRelease(io(), meta.version);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("checksum-mismatch");
  });

  it("returns cancelled when the signal is already aborted", async () => {
    writeFreeReleaseFixture(fixture);
    const controller = new AbortController();
    controller.abort();
    const result = await downloadFreeRelease(io({ signal: controller.signal }), bundledSourceVersion());
    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("fails closed with disk-full when statfs reports insufficient space", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    const base = io();
    const result = await downloadFreeRelease(
      { ...base, statfs: () => ({ availableBytes: 1 }) },
      meta.version,
    );
    expect(result).toMatchObject({ ok: false, reason: "disk-full" });
  });

  it("uses injected fetch against GitHub release URLs without guessing the archive name", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    const served = new Map<string, Uint8Array>([
      [githubReleaseAssetUrl(`v${meta.version}`, "release-descriptor.json.sha256"), new Uint8Array(readFileSync(join(fixture, "release-descriptor.json.sha256")))],
      [githubReleaseAssetUrl(`v${meta.version}`, "release-descriptor.json"), new Uint8Array(readFileSync(join(fixture, "release-descriptor.json")))],
      [githubReleaseAssetUrl(`v${meta.version}`, meta.freeName), new Uint8Array(readFileSync(join(fixture, meta.freeName)))],
      [githubReleaseAssetUrl(`v${meta.version}`, meta.metadataName), new Uint8Array(readFileSync(join(fixture, meta.metadataName)))],
    ]);
    const requested: string[] = [];
    const base = io();
    const result = await downloadFreeRelease(
      {
        fetchFn: (async (url: string) => {
          requested.push(url);
          const body = served.get(url);
          if (!body) return new Response(null, { status: 404 });
          return new Response(body, { status: 200 });
        }) as typeof fetch,
        readFileSync: base.readFileSync,
        writeFileSync: base.writeFileSync,
        mkdirSync: base.mkdirSync,
        existsSync: base.existsSync,
        renameSync: base.renameSync,
        rmSync: base.rmSync,
        cacheDir: base.cacheDir,
        cliVersion: base.cliVersion,
        signal: base.signal,
      },
      meta.version,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifestJson).toContain('"tier": "free"');
      expect(result.manualMd.length).toBeGreaterThan(0);
      expect(result.metadataSha256).toBe(meta.metadataSha);
    }
    expect(requested).toContain(githubReleaseAssetUrl(`v${meta.version}`, meta.freeName));
    expect(requested.some((url) => /moe-icons-free-/.test(url) && !url.endsWith(meta.freeName) && !url.includes("metadata"))).toBe(false);
  });

  it("uses a loopback HTTP fixture for success, 404, timeout and checksum failure", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    let mode: "ok" | "missing" | "slow" | "corrupt" = "ok";
    const server: Server = createServer((request, response) => {
      const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
      if (mode === "missing") { response.writeHead(404).end(); return; }
      if (mode === "slow") { setTimeout(() => response.end("late"), 100); return; }
      if (mode === "corrupt" && name === meta.freeName) { response.end("corrupt"); return; }
      try { response.end(readFileSync(join(fixture, name))); } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
    const { fixtureDir: _fixtureDir, ...base } = io();
    const remote = (timeoutMs = 1000) => ({ ...base, fixtureBaseUrl: `http://127.0.0.1:${address.port}`, timeoutMs });
    try {
      expect(await downloadFreeRelease(remote(), meta.version)).toMatchObject({ ok: true });
      rmSync(cache, { recursive: true, force: true }); mkdirSync(cache);
      mode = "missing"; expect(await downloadFreeRelease(remote(), meta.version)).toMatchObject({ ok: false, reason: "not-found" });
      mode = "slow"; expect(await downloadFreeRelease(remote(5), meta.version)).toMatchObject({ ok: false, reason: "offline-no-cache" });
      mode = "corrupt"; expect(await downloadFreeRelease(remote(), meta.version)).toMatchObject({ ok: false, reason: "checksum-mismatch" });
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });
});
