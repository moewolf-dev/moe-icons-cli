import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTarGz } from "../src/project/tar-gz.js";
import {
  parseBitmapShardDescriptor,
  fetchBitmapShardDescriptor,
  verifyBitmapShardArchive,
  bitmapShardCachePath,
  downloadAndCacheBitmapShard,
  type BitmapShardDescriptor,
} from "../src/core/bitmap-shard-download.js";
import { buildBitmapShardFilename, buildBitmapShardObjectKey } from "../src/core/bitmap-shards.js";
import { BITMAP_SHARD_BUDGET } from "../src/core/bitmap-shard-budget.js";

const VERSION = "1.2.3";
const HOST = "r2.example.invalid";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function makeWebp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function cacheIo() {
  return {
    mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
    writeFileSync: (path: string, data: Uint8Array) => writeFileSync(path, data),
    renameSync: (from: string, to: string) => renameSync(from, to),
    existsSync: (path: string) => existsSync(path),
    rmSync: (path: string, options?: { force?: boolean }) => rmSync(path, options),
    readFileSync: (path: string) => readFileSync(path),
    readdirSync: (path: string) => readdirSync(path),
  };
}

/** A body that never yields and errors when the request signal aborts. */
function abortableBody(init?: RequestInit): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = () => controller.error(new DOMException("aborted", "AbortError"));
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail, { once: true });
    },
    pull() {
      return new Promise<void>(() => {});
    },
  });
}

function buildShard() {
  const icon = makeWebp(128, 128);
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId: "moe-3d-metal",
    imageSize: { width: 128, height: 128 }, format: "webp", iconCount: 1,
    files: [{ iconId: "archive-box", path: "icons/archive-box.webp", byteSize: icon.length, sha256: sha256(icon) }],
  })}\n`);
  const bytes = createTarGz({ "manifest.json": manifest, "icons/archive-box.webp": icon });
  const filename = buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION });
  const descriptor: BitmapShardDescriptor = {
    tier: "pro",
    version: VERSION,
    descriptorSha256: "d".repeat(64),
    styleGroupId: "moe-3d-metal",
    imageSize: { width: 128, height: 128 },
    format: "webp",
    filename,
    url: `https://${HOST}/bucket/${buildBitmapShardObjectKey({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION })}?X-Amz-Signature=sig`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    size: bytes.byteLength,
    sha256: sha256(bytes),
    manifestSha256: sha256(manifest),
  };
  return { bytes, descriptor };
}

describe("bitmap shard download (DEV-G07)", () => {
  it("verifies the archive, manifest and icon bytes", () => {
    const { bytes, descriptor } = buildShard();
    const verified = verifyBitmapShardArchive(bytes, descriptor);
    expect(verified.iconIds).toEqual(["archive-box"]);
    expect(verified.files["icons/archive-box.webp"]).toBeInstanceOf(Uint8Array);
  });

  it("fails closed on size, digest, manifest and dimension drift", () => {
    const { bytes, descriptor } = buildShard();
    const shorter = bytes.subarray(0, bytes.byteLength - 1);
    expect(() => verifyBitmapShardArchive(shorter, descriptor)).toThrow(/size mismatch/);
    const extended = new Uint8Array([...bytes, 0]);
    expect(() => verifyBitmapShardArchive(extended, descriptor)).toThrow(/size mismatch/);
    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => verifyBitmapShardArchive(tampered, descriptor)).toThrow(/SHA-256 mismatch/);
    expect(() => verifyBitmapShardArchive(bytes, { ...descriptor, manifestSha256: "e".repeat(64) })).toThrow(/manifest digest/);
  });

  it("rejects a descriptor whose filename does not match its tuple", () => {
    const { descriptor } = buildShard();
    expect(parseBitmapShardDescriptor({ ok: true, ...descriptor }, Date.now())).toMatchObject({ tier: "pro" });
    expect(() => parseBitmapShardDescriptor({ ok: false, ...descriptor }, Date.now())).toThrow(/invalid/);
    expect(() => parseBitmapShardDescriptor({ ...descriptor, filename: "moe-icons-bitmap-pro-moe-3d-metal-256x256-png-1.2.3.tgz" }, Date.now())).toThrow(/filename/);
    expect(() => parseBitmapShardDescriptor({ ...descriptor, format: "svg" }, Date.now())).toThrow(/invalid/);
    expect(() => parseBitmapShardDescriptor({ ...descriptor, url: "http://r2.example.invalid/x" }, Date.now())).toThrow(/insecure/);
  });

  it("fetches one descriptor with bearer and never forwards it to R2", async () => {
    const { descriptor } = buildShard();
    const calls: Array<{ url: string; auth?: string | undefined }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: init?.headers ? new Headers(init.headers).get("authorization") ?? undefined : undefined });
      if (url.includes("/v1/icon-library/pro/bitmap-shard-descriptor")) return Response.json(descriptor);
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const fetched = await fetchBitmapShardDescriptor(
      { version: VERSION, descriptorSha256: descriptor.descriptorSha256, styleGroupId: descriptor.styleGroupId, imageSize: descriptor.imageSize, format: descriptor.format },
      "access-fixture",
      { fetch: fetchMock, now: Date.now() },
    );
    expect(fetched.filename).toBe(descriptor.filename);
    expect(calls[0]?.auth).toBe("Bearer access-fixture");
  });

  it("downloads from the signed host and atomically caches the verified shard", async () => {
    const { bytes, descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-cache-"));
    try {
      const fetchMock = (async () => new Response(bytes)) as typeof fetch;
      const verified = await downloadAndCacheBitmapShard(descriptor, {
        cacheDir: dir,
        io: {
          mkdirSync: (path) => mkdirSync(path, { recursive: true }),
          writeFileSync: (path, data) => writeFileSync(path, data),
          renameSync: (from, to) => renameSync(from, to),
          existsSync: (path) => existsSync(path),
          rmSync: (path, options) => rmSync(path, options),
          readFileSync: (path) => readFileSync(path),
          readdirSync: (path) => readdirSync(path),
        },
        allowedHosts: [HOST],
        fetch: fetchMock,
        now: Date.now(),
      });
      expect(verified.iconIds).toEqual(["archive-box"]);
      const cachePath = bitmapShardCachePath(dir, descriptor);
      expect(existsSync(cachePath)).toBe(true);
      expect(sha256(readFileSync(cachePath))).toBe(descriptor.sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEV-G08: aborts a slow stream at the timeout and writes no cache", async () => {
    const { descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-slow-"));
    try {
      const fetchMock = (async (_url: unknown, init?: RequestInit) => new Response(abortableBody(init))) as typeof fetch;
      await expect(downloadAndCacheBitmapShard(descriptor, {
        cacheDir: dir, io: cacheIo(), fetch: fetchMock, allowedHosts: [HOST], now: Date.now(), timeoutMs: 20,
      })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(existsSync(bitmapShardCachePath(dir, descriptor))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEV-G08: a broken stream fails closed and writes no cache", async () => {
    const { descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-broken-"));
    try {
      const fetchMock = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("socket reset"));
        },
      }))) as typeof fetch;
      await expect(downloadAndCacheBitmapShard(descriptor, {
        cacheDir: dir, io: cacheIo(), fetch: fetchMock, allowedHosts: [HOST], now: Date.now(),
      })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(existsSync(bitmapShardCachePath(dir, descriptor))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEV-G08: insufficient cache space (incl. staging headroom) fails closed before any download", async () => {
    const { descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-disk-"));
    try {
      let called = false;
      const fetchMock = (async () => { called = true; return new Response(null, { status: 500 }); }) as typeof fetch;
      // Just above the compressed size but below size + staging headroom.
      await expect(downloadAndCacheBitmapShard(descriptor, {
        cacheDir: dir, io: cacheIo(), fetch: fetchMock, allowedHosts: [HOST], now: Date.now(),
        statfs: () => ({ availableBytes: descriptor.size + BITMAP_SHARD_BUDGET.tempDiskBytes - 1 }),
      })).rejects.toMatchObject({ code: "DISK_FULL" });
      expect(called).toBe(false);
      expect(existsSync(bitmapShardCachePath(dir, descriptor))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEV-G08-R2: an over-budget descriptor fails before any fetch or cache write", async () => {
    const { descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-oversize-"));
    try {
      let called = false;
      const fetchMock = (async () => { called = true; return new Response(null, { status: 500 }); }) as typeof fetch;
      const oversized = { ...descriptor, size: BITMAP_SHARD_BUDGET.compressedBytes + 1 };
      await expect(downloadAndCacheBitmapShard(oversized, {
        cacheDir: dir, io: cacheIo(), fetch: fetchMock, allowedHosts: [HOST], now: Date.now(),
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(called).toBe(false);
      expect(existsSync(bitmapShardCachePath(dir, descriptor))).toBe(false);
      const cacheRoot = join(dir, "bitmap-shards");
      expect(existsSync(cacheRoot) ? readdirSync(cacheRoot).length : 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEV-G08: a throwing statfs fails closed instead of being swallowed", async () => {
    const { descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-statfs-"));
    try {
      let called = false;
      const fetchMock = (async () => { called = true; return new Response(null, { status: 500 }); }) as typeof fetch;
      await expect(downloadAndCacheBitmapShard(descriptor, {
        cacheDir: dir, io: cacheIo(), fetch: fetchMock, allowedHosts: [HOST], now: Date.now(),
        statfs: () => { throw new Error("statfs unavailable"); },
      })).rejects.toMatchObject({ code: "DISK_FULL" });
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEV-G08: the default descriptor timeout is the frozen budget", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as typeof fetch;
      const pending = fetchBitmapShardDescriptor(
        { version: VERSION, descriptorSha256: "d".repeat(64), styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp" },
        "access-fixture",
        { fetch: fetchMock },
      );
      const assertion = expect(pending).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      await vi.advanceTimersByTimeAsync(BITMAP_SHARD_BUDGET.descriptorTimeoutMs + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("DEV-G08: the default download timeout is the frozen budget", async () => {
    vi.useFakeTimers();
    const { descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-dltimeout-"));
    try {
      const fetchMock = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const fail = () => controller.error(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) fail();
          else init?.signal?.addEventListener("abort", fail, { once: true });
        },
        pull() { return new Promise<void>(() => {}); },
      }))) as typeof fetch;
      const pending = downloadAndCacheBitmapShard(descriptor, {
        cacheDir: dir, io: cacheIo(), fetch: fetchMock, allowedHosts: [HOST], now: Date.now(),
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      await vi.advanceTimersByTimeAsync(BITMAP_SHARD_BUDGET.downloadTimeoutMs + 1);
      await assertion;
      expect(existsSync(bitmapShardCachePath(dir, descriptor))).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEV-G08: a concurrent abort cancels the download without a partial cache", async () => {
    const { descriptor } = buildShard();
    const dir = mkdtempSync(join(tmpdir(), "moe-shard-cancel-"));
    try {
      const controller = new AbortController();
      const fetchMock = (async (_url: unknown, init?: RequestInit) => {
        setTimeout(() => controller.abort(), 0);
        return new Response(abortableBody(init));
      }) as typeof fetch;
      await expect(downloadAndCacheBitmapShard(descriptor, {
        cacheDir: dir, io: cacheIo(), fetch: fetchMock, allowedHosts: [HOST], now: Date.now(), signal: controller.signal,
      })).rejects.toBeTruthy();
      expect(existsSync(bitmapShardCachePath(dir, descriptor))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
