import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createTarGz } from "../src/project/tar-gz.js";
import { BITMAP_SHARD_BUDGET } from "../src/core/bitmap-shard-budget.js";
import { verifyBitmapShardArchive, type BitmapShardVerificationTarget } from "../src/core/bitmap-shard-download.js";
import { loadArchiveFiles } from "../src/core/generate.js";

const VERSION = "1.2.3";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function target(size: number, sha: string, manifestSha256 = "a".repeat(64)): BitmapShardVerificationTarget {
  return {
    version: VERSION,
    styleGroupId: "moe-3d-metal",
    imageSize: { width: 128, height: 128 },
    format: "webp",
    size,
    sha256: sha,
    manifestSha256,
  };
}

function makeWebp(width: number, height: number, length = 30): Buffer {
  const b = Buffer.alloc(Math.max(length, 30));
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16); b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe("DEV-G08 shard resource budgets", () => {
  it("fails closed on a gzip bomb before allocating the expansion", () => {
    const bomb = gzipSync(Buffer.alloc(BITMAP_SHARD_BUDGET.expandedBytes + 4096));
    expect(() => verifyBitmapShardArchive(bomb, target(bomb.byteLength, sha256(bomb)))).toThrow(/archive rejected|too large/i);
  });

  it("enforces the entry cap", () => {
    const icon = makeWebp(128, 128);
    const files = Array.from({ length: BITMAP_SHARD_BUDGET.entries + 1 }, (_, index) => ({
      iconId: `icon-${index}`,
      path: `icons/icon-${index}.webp`,
      byteSize: icon.length,
      sha256: sha256(icon),
    }));
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId: "moe-3d-metal",
      imageSize: { width: 128, height: 128 }, format: "webp", iconCount: files.length, files,
    })}\n`);
    const archive: Record<string, Uint8Array> = { "manifest.json": manifest };
    for (const file of files) archive[file.path] = icon;
    const bytes = createTarGz(archive);
    expect(() => verifyBitmapShardArchive(bytes, target(bytes.byteLength, sha256(bytes)))).toThrow(/archive rejected|too many entries/i);
  });

  it("enforces the single-file payload budget", () => {
    const oversized = makeWebp(128, 128, BITMAP_SHARD_BUDGET.singleFileBytes + 16);
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId: "moe-3d-metal",
      imageSize: { width: 128, height: 128 }, format: "webp", iconCount: 1,
      files: [{ iconId: "archive-box", path: "icons/archive-box.webp", byteSize: oversized.length, sha256: sha256(oversized) }],
    })}\n`);
    const bytes = createTarGz({ "manifest.json": manifest, "icons/archive-box.webp": oversized });
    expect(() => verifyBitmapShardArchive(bytes, target(bytes.byteLength, sha256(bytes), sha256(manifest)))).toThrow(/single-file byte budget/);
  });
});

describe("DEV-G08 legacy aggregate-archive seam cannot bypass shards", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moe-budget-seam-"));
    writeFileSync(join(dir, "fixture.tgz"), Buffer.from(createTarGz({ "assets/x.svg": "<svg/>" })));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fs_ = { readFileSync, existsSync, readdirSync };

  it("rejects MOEICONS_BITMAP_ARCHIVE outside a local-test context", () => {
    const result = loadArchiveFiles(dir, { MOEICONS_BITMAP_ARCHIVE: join(dir, "fixture.tgz") }, fs_);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/local-test context/);
  });

  it("honors the fixture only under a local-test context", () => {
    const env = {
      MOEICONS_ENV: "local",
      MOEICONS_LIBRARY_VERSIONS_URL: "http://127.0.0.1:1/v1/icon-library/versions",
      MOEICONS_PRO_DESCRIPTOR_URL: "http://127.0.0.1:1/v1/icon-library/pro/artifact-descriptor",
      MOEICONS_BITMAP_ARCHIVE: join(dir, "fixture.tgz"),
    };
    const result = loadArchiveFiles(dir, env, fs_);
    expect(result.ok).toBe(true);
  });
});

describe("DEV-G08 frozen budget shape", () => {
  it("freezes concurrency 1 and all limits", () => {
    expect(BITMAP_SHARD_BUDGET.concurrency).toBe(1);
    for (const value of Object.values(BITMAP_SHARD_BUDGET)) {
      if (typeof value === "number") expect(value).toBeGreaterThan(0);
    }
    expect(BITMAP_SHARD_BUDGET.expandedBytes).toBeLessThanOrEqual(BITMAP_SHARD_BUDGET.tempDiskBytes * 2);
  });

  // OPS-04-06: the calibrated budget must admit the real release 0.0.17
  // six-shard matrix; the 512x512 png shard is the worst case and previously
  // exceeded the untested 64 MiB compressed cap.
  it("admits the measured OPS-04-06 worst-case shard", () => {
    const measured = {
      compressedBytes: 93_843_123, // 512x512 png moe-3d-metal
      expandedBytes: 94_408_209,
      singleFileBytes: 338_828, // largest icon payload
      totalDownloadBytes: 141_019_248, // six shards
      entries: 554,
    };
    expect(measured.compressedBytes).toBeLessThanOrEqual(BITMAP_SHARD_BUDGET.compressedBytes);
    expect(measured.expandedBytes).toBeLessThanOrEqual(BITMAP_SHARD_BUDGET.expandedBytes);
    expect(measured.singleFileBytes).toBeLessThanOrEqual(BITMAP_SHARD_BUDGET.singleFileBytes);
    expect(measured.totalDownloadBytes).toBeLessThanOrEqual(BITMAP_SHARD_BUDGET.totalDownloadBytes);
    expect(measured.entries).toBeLessThanOrEqual(BITMAP_SHARD_BUDGET.entries);
  });
});
