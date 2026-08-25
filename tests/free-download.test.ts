import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { downloadFreeRelease, bundledSourceVersion } from "../src/core/free-download.js";
import { githubReleaseAssetUrl, parseReleaseDescriptor, PUBLIC_FREE_REPO } from "../src/core/release-descriptor.js";
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

  it("uses injected fetch against GitHub release URLs without guessing the archive name", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    const served = new Map<string, Uint8Array>([
      [githubReleaseAssetUrl(`v${meta.version}`, "release-descriptor.json.sha256"), new Uint8Array(readFileSync(join(fixture, "release-descriptor.json.sha256")))],
      [githubReleaseAssetUrl(`v${meta.version}`, "release-descriptor.json"), new Uint8Array(readFileSync(join(fixture, "release-descriptor.json")))],
      [githubReleaseAssetUrl(`v${meta.version}`, meta.freeName), new Uint8Array(readFileSync(join(fixture, meta.freeName)))],
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
        cacheDir: base.cacheDir,
        cliVersion: base.cliVersion,
        signal: base.signal,
      },
      meta.version,
    );
    expect(result.ok).toBe(true);
    expect(requested).toContain(githubReleaseAssetUrl(`v${meta.version}`, meta.freeName));
    expect(requested.some((url) => /moe-icons-free-/.test(url) && !url.endsWith(meta.freeName))).toBe(false);
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
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
