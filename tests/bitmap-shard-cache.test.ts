import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTarGz } from "../src/project/tar-gz.js";
import type { IconCatalog } from "../src/catalog/catalog.js";
import type { CacheIo } from "../src/core/cache.js";
import { buildBitmapShardFilename, buildBitmapShardObjectKey } from "../src/core/bitmap-shards.js";
import {
  defaultWarmupTuples,
  missingBitmapShardTuples,
  readBitmapShardCacheManifest,
  warmDefaultBitmapShards,
  writeBitmapShardCacheManifest,
} from "../src/core/bitmap-shard-cache.js";
import type { BitmapShard } from "../src/core/bitmap-shards.js";

const VERSION = "1.2.3";
const SHA_A = "a".repeat(64);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function makeWebp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function shardBytes(styleGroupId: string, width: number, icons: string[]) {
  const icon = makeWebp(width, width);
  const files = icons.map((iconId) => ({ iconId, path: `icons/${iconId}.webp`, byteSize: icon.length, sha256: sha256(icon) }));
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId,
    imageSize: { width, height: width }, format: "webp", iconCount: icons.length, files,
  })}\n`);
  const tar = { "manifest.json": manifest } as Record<string, Uint8Array>;
  for (const file of files) tar[file.path] = icon;
  return { bytes: createTarGz(tar), manifestSha256: sha256(manifest) };
}

const CATALOG: IconCatalog = {
  schemaVersion: 1,
  catalogVersion: VERSION,
  sourceVersion: VERSION,
  sourceCommit: "c".repeat(40),
  generatorCommit: "d".repeat(40),
  styleGroups: [
    { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    {
      id: "moe-a-flat",
      type: "bitmap",
      tiers: ["pro"],
      formats: ["webp"],
      imageSizes: [128],
      variants: ["moe-a-flat-128-webp"],
    },
    {
      id: "moe-3d-metal",
      type: "bitmap",
      tiers: ["pro"],
      formats: ["webp", "png"],
      imageSizes: [128, 256],
      variants: ["moe-3d-metal-128-webp", "moe-3d-metal-256-webp"],
    },
  ],
  icons: [
    { id: "archive-box", prefix: "archive", label: "Archive Box", aliases: [], availableIn: ["moe-outline", "moe-a-flat", "moe-3d-metal"], targets: ["react"] },
  ],
};

function cacheIo(): CacheIo {
  return {
    mkdirSync: (path) => mkdirSync(path, { recursive: true }),
    writeFileSync: (path, data) => writeFileSync(path, data),
    renameSync: (from, to) => renameSync(from, to),
    existsSync: (path) => existsSync(path),
    rmSync: (path, options) => rmSync(path, options),
    readFileSync: (path) => readFileSync(path),
    readdirSync: (path) => readdirSync(path),
  };
}

function fetchMock(calls: number[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/bitmap-shard-descriptor")) {
      calls.push(1);
      const body = JSON.parse(String(init?.body)) as { styleGroupId: string; imageSize: { width: number }; format: "webp" | "png" };
      const entry = shardBytes(body.styleGroupId, body.imageSize.width, ["archive-box"]);
      const filename = buildBitmapShardFilename({
        tier: "pro",
        styleGroupId: body.styleGroupId,
        imageSize: { width: body.imageSize.width, height: body.imageSize.width },
        format: body.format,
        resourceVersion: VERSION,
      });
      return Response.json({
        tier: "pro", version: VERSION, descriptorSha256: SHA_A, styleGroupId: body.styleGroupId,
        imageSize: { width: body.imageSize.width, height: body.imageSize.width }, format: body.format,
        filename, url: `https://r2.example.invalid/${encodeURIComponent(filename)}?X-Amz-Signature=s`,
        expiresAt: "2099-01-01T00:00:00.000Z", size: entry.bytes.byteLength, sha256: sha256(entry.bytes), manifestSha256: entry.manifestSha256,
      });
    }
    const filename = decodeURIComponent(url.split("/").pop()!.split("?")[0]!);
    const group = CATALOG.styleGroups.find((candidate) => filename.includes(`-${candidate.id}-`));
    if (!group || group.type !== "bitmap") return new Response(null, { status: 404 });
    const entry = shardBytes(group.id, 128, ["archive-box"]);
    return new Response(entry.bytes, { status: 200 });
  }) as typeof fetch;
}

describe("W2 bitmap shard cache", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("W2-A1 selects every bitmap group's 128/webp shard, sorted, skipping svg groups", () => {
    expect(defaultWarmupTuples(CATALOG).map((tuple) => `${tuple.styleGroupId}/${tuple.imageSize.width}/${tuple.format}`)).toEqual([
      "moe-3d-metal/128/webp",
      "moe-a-flat/128/webp",
    ]);
    expect(defaultWarmupTuples({ ...CATALOG, styleGroups: [CATALOG.styleGroups[0]!] })).toEqual([]);
  });

  it("W2-A3/B2 round-trips the manifest and computes missing tuples", () => {
    dir = mkdtempSync(join(tmpdir(), "moe-shard-cache-"));
    const io = cacheIo();
    const manifest = readBitmapShardCacheManifest(dir, io);
    expect(manifest.shards).toEqual([]);

    const filename = buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-a-flat", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION });
    const pin: BitmapShard = {
      schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId: "moe-a-flat",
      imageSize: { width: 128, height: 128 }, format: "webp", filename,
      objectKey: buildBitmapShardObjectKey({ tier: "pro", styleGroupId: "moe-a-flat", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION, filename }),
      compressedSize: 10, expandedSize: 10, sha256: SHA_A, fileCount: 1, manifestSha256: SHA_A,
    };
    writeBitmapShardCacheManifest(dir, io, [pin], 1_700_000_000_000);
    const reread = readBitmapShardCacheManifest(dir, io);
    expect(reread.shards).toHaveLength(1);
    expect(reread.updatedAt).toBe("2023-11-14T22:13:20.000Z");
    const expected = defaultWarmupTuples(CATALOG);
    expect(missingBitmapShardTuples(reread, expected, VERSION).map((t) => t.styleGroupId)).toEqual(["moe-3d-metal"]);
    expect(missingBitmapShardTuples(reread, expected, "9.9.9")).toHaveLength(2);
  });

  it("treats a corrupt manifest as empty", () => {
    dir = mkdtempSync(join(tmpdir(), "moe-shard-cache-"));
    const io = cacheIo();
    const path = join(dir, "bitmap-shards", "manifest.json");
    mkdirSync(join(dir, "bitmap-shards"), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(readBitmapShardCacheManifest(dir, io).shards).toEqual([]);
  });

  it("W2-A2/B7 warms missing shards once, then reuses the cache with zero network calls", async () => {
    dir = mkdtempSync(join(tmpdir(), "moe-shard-cache-"));
    const io = cacheIo();
    const calls: number[] = [];
    const first = await warmDefaultBitmapShards({
      catalog: CATALOG, version: VERSION, descriptorSha256: SHA_A, accessToken: "tok",
      cacheDir: dir, io, fetch: fetchMock(calls), allowedHosts: ["r2.example.invalid"], now: 1_700_000_000_000,
    });
    expect(first.downloaded).toBe(2);
    expect(first.reused).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    const afterFirst = calls.length;

    const second = await warmDefaultBitmapShards({
      catalog: CATALOG, version: VERSION, descriptorSha256: SHA_A, accessToken: "tok",
      cacheDir: dir, io, fetch: fetchMock(calls), allowedHosts: ["r2.example.invalid"],
    });
    expect(second.downloaded).toBe(0);
    expect(second.reused).toBe(2);
    expect(calls.length).toBe(afterFirst);
  });

  it("emits a plan before any network request and reports progress phases", async () => {
    dir = mkdtempSync(join(tmpdir(), "moe-shard-cache-"));
    const calls: number[] = [];
    const phases: string[] = [];
    let planMissing = -1;
    await warmDefaultBitmapShards({
      catalog: CATALOG, version: VERSION, descriptorSha256: SHA_A, accessToken: "tok",
      cacheDir: dir, io: cacheIo(), fetch: fetchMock(calls), allowedHosts: ["r2.example.invalid"],
      onPlan: (plan) => { planMissing = plan.missing.length; },
      onProgress: (event) => phases.push(event.phase),
    });
    expect(planMissing).toBe(2);
    expect(phases).toContain("descriptor");
    expect(phases).toContain("done");
  });

  it("does no work when the catalog has no bitmap groups", async () => {
    dir = mkdtempSync(join(tmpdir(), "moe-shard-cache-"));
    const calls: number[] = [];
    const result = await warmDefaultBitmapShards({
      catalog: { ...CATALOG, styleGroups: [] }, version: VERSION, descriptorSha256: SHA_A, accessToken: "tok",
      cacheDir: dir, io: cacheIo(), fetch: fetchMock(calls), allowedHosts: ["r2.example.invalid"],
    });
    expect(result).toEqual({ tuples: [], pins: [], downloaded: 0, reused: 0 });
    expect(calls).toEqual([]);
  });
});
