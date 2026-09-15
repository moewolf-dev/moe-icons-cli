import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runProInstallUseCase } from "../src/core/pro-install.js";
import { parseInstallMetadata, sha256Bytes } from "../src/project/install-metadata.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";
import type { CommandContext } from "../src/core/context.js";
import type { IconCatalog } from "../src/catalog/catalog.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";

const VERSION = "1.2.3";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function field(value: string, length: number): Buffer {
  const buffer = Buffer.alloc(length, 0);
  buffer.write(value.slice(0, length - 1), 0, "utf8");
  return buffer;
}
function octal(value: number, length: number): string {
  return field(`${value.toString(8).padStart(length - 1, "0")} `, length).toString("latin1");
}
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 99), 0, "utf8");
  header.write(octal(0o644, 8), 100, "latin1");
  header.write(octal(0, 8), 108, "latin1");
  header.write(octal(0, 8), 116, "latin1");
  header.write(octal(size, 12), 124, "latin1");
  header.write(octal(0, 12), 136, "latin1");
  header.write("        ", 148, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\x00", 257, "latin1");
  header.write("00", 263, "latin1");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\x00 `, 148, "latin1");
  return header;
}
function buildTar(entries: Array<[string, Buffer]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of entries) {
    blocks.push(tarHeader(name, bytes.length), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}
function makeWebp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16); b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function buildShard(size: number, format: "webp" | "png", iconIds: string[]) {
  const icon = makeWebp(size, size);
  const files = iconIds.map((iconId) => ({ iconId, path: `icons/${iconId}.${format}`, byteSize: icon.length, sha256: sha256(icon) }));
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId: "moe-3d-metal",
    imageSize: { width: size, height: size }, format, iconCount: files.length, files,
  })}\n`);
  const archive: Record<string, Uint8Array> = { "manifest.json": manifest };
  for (const file of files) archive[file.path] = icon;
  const bytes = gzipSync(buildTar(Object.entries(archive).map(([name, data]) => [name, Buffer.from(data)] as [string, Buffer])));
  const filename = `moe-icons-bitmap-pro-moe-3d-metal-${size}x${size}-${format}-${VERSION}.tgz`;
  return { bytes, manifestSha256: sha256(manifest), filename };
}

const CATALOG: IconCatalog = {
  schemaVersion: 1, catalogVersion: VERSION, sourceVersion: VERSION,
  sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40),
  styleGroups: [
    { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    { id: "moe-3d-metal", type: "bitmap", tiers: ["pro"], formats: ["webp", "png"], imageSizes: [128, 256], variants: ["moe-3d-metal-128-webp", "moe-3d-metal-256-png"] },
  ],
  icons: [
    { id: "archive-box", prefix: "archive", label: "Archive Box", aliases: [], availableIn: ["moe-outline", "moe-3d-metal"], targets: ["react"] },
  ],
};

const SESSION: StoredSession = { accountId: "auth0|fixture", accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresAt: Date.parse("2099-01-01T00:00:00Z"), scope: "openid", storedAt: 1 };
const store = (): TokenStore => ({ get: () => SESSION, getActive: () => SESSION, set() {}, delete() {}, clear() {} });

function context(dir: string, env: Record<string, string>): CommandContext {
  return {
    cwd: dir, env, signal: new AbortController().signal, now: () => new Date("2026-08-24T00:00:00Z"),
    ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
  };
}

const fs_ = { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, copyFileSync };

describe("DEV-G10-R1 two-phase Pro bitmap install", () => {
  let dir: string;
  let release: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moe-pro-2phase-"));
    release = mkdtempSync(join(tmpdir(), "moe-pro-2phase-release-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  });

  function writeConfig(styleGroup: string, target = "react"): void {
    writeFileSync(join(dir, "moeicons.config.jsonc"), JSON.stringify({
      schemaVersion: 2, tier: "pro", target, outputDir: "src/moeicons", defaultTheme: "metal",
      themes: { metal: { styleGroup, format: "webp", imageSize: 128 } },
      icons: ["archive-box"],
    }));
  }

  it("reads a bitmap config before the release catalog, then pins the shard against it", async () => {
    const meta = writeFreeReleaseFixture(release, { tier: "pro", version: VERSION, catalogOverride: CATALOG });
    const archive = new Uint8Array(readFileSync(join(release, meta.freeName)));
    const metadataArchive = new Uint8Array(readFileSync(join(release, meta.metadataName)));
    const shard = buildShard(128, "webp", ["archive-box"]);
    const shardCalls: Array<{ kind: "api" | "r2"; auth?: string | null }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = init?.headers ? new Headers(init.headers).get("authorization") : null;
      if (url.includes("artifact-descriptor")) {
        return Response.json({
          ok: true, tier: "pro", version: VERSION, descriptorSha256: meta.descriptorSha,
          catalogFilename: "catalog.json", catalogSha256: meta.catalogSha,
          url: `http://127.0.0.1:1/pro.tgz`, expiresAt: "2099-01-01T00:00:00Z",
          size: archive.byteLength, sha256: meta.freeSha,
          metadata: { url: `http://127.0.0.1:1/pro-meta.tgz`, expiresAt: "2099-01-01T00:00:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha },
        });
      }
      if (url.includes("bitmap-shard-descriptor")) {
        shardCalls.push({ kind: "api", auth });
        const body = JSON.parse(String(init?.body)) as { imageSize: { width: number }; format: "webp" | "png" };
        return Response.json({
          tier: "pro", version: VERSION, descriptorSha256: meta.descriptorSha, styleGroupId: "moe-3d-metal",
          imageSize: { width: body.imageSize.width, height: body.imageSize.width }, format: body.format,
          filename: shard.filename, url: `http://127.0.0.1:1/${shard.filename}`, expiresAt: "2099-01-01T00:00:00Z",
          size: shard.bytes.byteLength, sha256: sha256(shard.bytes), manifestSha256: shard.manifestSha256,
        });
      }
      if (url.includes("pro-meta.tgz")) return new Response(metadataArchive);
      if (url.includes("pro.tgz")) return new Response(archive);
      if (url.endsWith(shard.filename)) {
        shardCalls.push({ kind: "r2", auth });
        return new Response(shard.bytes);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    writeConfig("moe-3d-metal");
    const result = await runProInstallUseCase(
      context(dir, {
        MOEICONS_CACHE_DIR: join(dir, ".cache"),
        MOEICONS_PRO_DESCRIPTOR_URL: "http://127.0.0.1:1/v1/icon-library/pro/artifact-descriptor",
        MOEICONS_BITMAP_SHARD_DESCRIPTOR_URL: "http://127.0.0.1:1/v1/icon-library/pro/bitmap-shard-descriptor",
      }),
      { fs: fs_, auth: { tokenStore: store() }, fetch: fetchMock, allowedHosts: ["127.0.0.1:1"] },
      { version: VERSION, descriptorSha256: meta.descriptorSha },
    );
    expect(result.artifactVersion).toBe(VERSION);
    const metadata = parseInstallMetadata(readFileSync(join(dir, ".moeicons", "install-metadata.json"), "utf8"), {});
    expect(metadata?.bitmapShards).toHaveLength(1);
    expect(metadata?.bitmapShards?.[0]).toMatchObject({ styleGroupId: "moe-3d-metal", format: "webp", resourceVersion: VERSION });
    expect(metadata?.bitmapShardSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(shardCalls.filter((call) => call.kind === "api").every((call) => call.auth === "Bearer access-fixture")).toBe(true);
    expect(shardCalls.filter((call) => call.kind === "r2").every((call) => call.auth === null)).toBe(true);
  });

  it("DEV-G10-R2: target and tuples come from a single config snapshot", async () => {
    const meta = writeFreeReleaseFixture(release, { tier: "pro", version: VERSION, catalogOverride: CATALOG });
    const archive = new Uint8Array(readFileSync(join(release, meta.freeName)));
    const metadataArchive = new Uint8Array(readFileSync(join(release, meta.metadataName)));
    const shard = buildShard(128, "webp", ["archive-box"]);
    let rewrote = false;
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("artifact-descriptor")) {
        return Response.json({
          ok: true, tier: "pro", version: VERSION, descriptorSha256: meta.descriptorSha,
          catalogFilename: "catalog.json", catalogSha256: meta.catalogSha,
          url: "http://127.0.0.1:1/pro.tgz", expiresAt: "2099-01-01T00:00:00Z",
          size: archive.byteLength, sha256: meta.freeSha,
          metadata: { url: "http://127.0.0.1:1/pro-meta.tgz", expiresAt: "2099-01-01T00:00:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha },
        });
      }
      if (url.includes("bitmap-shard-descriptor")) {
        const body = JSON.parse(String(init?.body)) as { imageSize: { width: number }; format: "webp" | "png" };
        return Response.json({
          tier: "pro", version: VERSION, descriptorSha256: meta.descriptorSha, styleGroupId: "moe-3d-metal",
          imageSize: { width: body.imageSize.width, height: body.imageSize.width }, format: body.format,
          filename: shard.filename, url: `http://127.0.0.1:1/${shard.filename}`, expiresAt: "2099-01-01T00:00:00Z",
          size: shard.bytes.byteLength, sha256: sha256(shard.bytes), manifestSha256: shard.manifestSha256,
        });
      }
      if (url.includes("pro-meta.tgz")) return new Response(metadataArchive);
      if (url.includes("pro.tgz")) {
        // The on-disk config changes mid-download: the snapshot must still win.
        if (!rewrote) { rewrote = true; writeConfig("moe-3d-metal", "vue"); }
        return new Response(archive);
      }
      if (url.endsWith(shard.filename)) return new Response(shard.bytes);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    writeConfig("moe-3d-metal", "react");
    const result = await runProInstallUseCase(
      context(dir, {
        MOEICONS_CACHE_DIR: join(dir, ".cache"),
        MOEICONS_PRO_DESCRIPTOR_URL: "http://127.0.0.1:1/v1/icon-library/pro/artifact-descriptor",
        MOEICONS_BITMAP_SHARD_DESCRIPTOR_URL: "http://127.0.0.1:1/v1/icon-library/pro/bitmap-shard-descriptor",
      }),
      { fs: fs_, auth: { tokenStore: store() }, fetch: fetchMock, allowedHosts: ["127.0.0.1:1"] },
      { version: VERSION, descriptorSha256: meta.descriptorSha },
    );
    expect(rewrote).toBe(true);
    expect(result.artifactVersion).toBe(VERSION);
    const metadata = parseInstallMetadata(readFileSync(join(dir, ".moeicons", "install-metadata.json"), "utf8"), {});
    expect(metadata?.target).toBe("react");
    expect(metadata?.bitmapShards).toHaveLength(1);
  });

  it("fails closed when the release catalog does not ship the configured group", async () => {
    const releaseCatalog = { ...CATALOG, styleGroups: CATALOG.styleGroups.filter((group) => group.id !== "moe-3d-metal") };
    const meta = writeFreeReleaseFixture(release, { tier: "pro", version: VERSION, catalogOverride: releaseCatalog });
    const archive = new Uint8Array(readFileSync(join(release, meta.freeName)));
    const metadataArchive = new Uint8Array(readFileSync(join(release, meta.metadataName)));
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("artifact-descriptor")) {
        return Response.json({
          ok: true, tier: "pro", version: VERSION, descriptorSha256: meta.descriptorSha,
          catalogFilename: "catalog.json", catalogSha256: meta.catalogSha,
          url: "http://127.0.0.1:1/pro.tgz", expiresAt: "2099-01-01T00:00:00Z",
          size: archive.byteLength, sha256: meta.freeSha,
          metadata: { url: "http://127.0.0.1:1/pro-meta.tgz", expiresAt: "2099-01-01T00:00:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha },
        });
      }
      if (url.includes("pro-meta.tgz")) return new Response(metadataArchive);
      if (url.includes("pro.tgz")) return new Response(archive);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    writeConfig("moe-3d-metal");
    await expect(runProInstallUseCase(
      context(dir, { MOEICONS_CACHE_DIR: join(dir, ".cache"), MOEICONS_PRO_DESCRIPTOR_URL: "http://127.0.0.1:1/v1/icon-library/pro/artifact-descriptor" }),
      { fs: fs_, auth: { tokenStore: store() }, fetch: fetchMock, allowedHosts: ["127.0.0.1:1"] },
      { version: VERSION, descriptorSha256: meta.descriptorSha },
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(existsSync(join(dir, ".moeicons", "install-metadata.json"))).toBe(false);
    // DEV-G10-R2: a strictly rejected config writes no code/metadata cache.
    const cacheDir = join(dir, ".cache");
    expect(existsSync(cacheDir) ? readdirSync(cacheDir).length : 0).toBe(0);
  });
});

void sha256Bytes;
