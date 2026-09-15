import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTarGz } from "../src/project/tar-gz.js";
import {
  bitmapShardSetSha256,
  buildBitmapShardFilename,
  buildBitmapShardObjectKey,
  type BitmapShard,
} from "../src/core/bitmap-shards.js";
import { bitmapShardCachePath, bitmapShardVerificationTargetFromPin } from "../src/core/bitmap-shard-download.js";
import {
  loadPinnedBitmapShardAssets,
  resolveConfiguredBitmapShards,
} from "../src/core/bitmap-shard-resolver.js";
import { runGenerateUseCase } from "../src/core/generate.js";
import {
  parseInstallMetadata,
  serializeInstallMetadata,
  sha256Bytes,
  type InstallMetadata,
} from "../src/project/install-metadata.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";
import type { IconCatalog } from "../src/catalog/catalog.js";
import type { CommandContext } from "../src/core/context.js";

const VERSION = "1.2.3";
const SHA_A = "a".repeat(64);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function makePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
function makeWebp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(22, 4); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16); b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}

type BitmapSize = 128 | 256 | 512;
type BitmapFormat = "png" | "webp";

const SIZES: Array<[BitmapSize, BitmapFormat]> = [
  [128, "png"], [128, "webp"], [256, "png"], [256, "webp"], [512, "png"], [512, "webp"],
];

const CATALOG: IconCatalog = {
  schemaVersion: 1,
  catalogVersion: VERSION,
  sourceVersion: VERSION,
  sourceCommit: "c".repeat(40),
  generatorCommit: "d".repeat(40),
  styleGroups: [
    { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
    {
      id: "moe-3d-metal",
      type: "bitmap",
      tiers: ["pro"],
      formats: ["webp", "png"],
      imageSizes: [128, 256, 512],
      variants: SIZES.map(([size, format]) => `moe-3d-metal-${size}-${format}`),
    },
  ],
  icons: [
    { id: "archive-box", prefix: "archive", label: "Archive Box", aliases: [], availableIn: ["moe-outline", "moe-3d-metal"], targets: ["react"] },
  ],
};

function config(themes: Record<string, { styleGroup: string; format?: BitmapFormat; imageSize?: BitmapSize }>): MoeiconsConfigFile {
  return {
    schemaVersion: 2,
    tier: "pro",
    target: "react",
    outputDir: "src/moeicons",
    defaultTheme: Object.keys(themes)[0] as string,
    themes,
    icons: ["archive-box"],
  };
}

function shardBytes(styleGroupId: string, width: number, format: BitmapFormat, icons: string[]) {
  const icon = format === "webp" ? makeWebp(width, width) : makePng(width, width);
  const files = icons.map((iconId) => ({ iconId, path: `icons/${iconId}.${format}`, byteSize: icon.length, sha256: sha256(icon) }));
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId,
    imageSize: { width, height: width }, format, iconCount: icons.length, files,
  })}\n`);
  const tar = { "manifest.json": manifest } as Record<string, Uint8Array>;
  for (const file of files) tar[file.path] = icon;
  return { bytes: createTarGz(tar), manifestSha256: sha256(manifest), icon: new Uint8Array(icon) };
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

type FetchCall = { kind: "api" | "r2"; auth?: string | undefined };

function mockShardApi(payloads: Map<string, ReturnType<typeof shardBytes>>, calls: FetchCall[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = init?.headers ? new Headers(init.headers).get("authorization") ?? undefined : undefined;
    if (url.includes("/bitmap-shard-descriptor")) {
      calls.push({ kind: "api", auth });
      const body = JSON.parse(String(init?.body)) as { styleGroupId: string; imageSize: { width: number }; format: BitmapFormat };
      const entry = payloads.get(`${body.imageSize.width}-${body.format}`)!;
      const filename = buildBitmapShardFilename({ tier: "pro", styleGroupId: body.styleGroupId, imageSize: { width: body.imageSize.width, height: body.imageSize.width }, format: body.format, resourceVersion: VERSION });
      return Response.json({
        tier: "pro", version: VERSION, descriptorSha256: SHA_A, styleGroupId: body.styleGroupId,
        imageSize: { width: body.imageSize.width, height: body.imageSize.width }, format: body.format,
        filename, url: `https://r2.example.invalid/${encodeURIComponent(filename)}?X-Amz-Signature=s`,
        expiresAt: "2099-01-01T00:00:00.000Z", size: entry.bytes.byteLength, sha256: sha256(entry.bytes), manifestSha256: entry.manifestSha256,
      });
    }
    calls.push({ kind: "r2", auth });
    const filename = decodeURIComponent(url.split("/").pop()!.split("?")[0]!);
    const match = [...payloads.entries()].find(([key]) => {
      const [size, format] = key.split("-");
      return buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: Number(size), height: Number(size) }, format: format as BitmapFormat, resourceVersion: VERSION }) === filename;
    });
    return new Response(match ? match[1].bytes : null, { status: match ? 200 : 404 });
  }) as typeof fetch;
}

function payloadsFor(tuples: Array<[number, BitmapFormat]>) {
  const payloads = new Map<string, ReturnType<typeof shardBytes>>();
  for (const [size, format] of tuples) payloads.set(`${size}-${format}`, shardBytes("moe-3d-metal", size, format, ["archive-box"]));
  return payloads;
}

const OFFLINE_TUPLE = [{ styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp" as const }];

describe("DEV-G07 install: selected shards, pins and offline reuse", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moe-shard-install-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function fetchConfigured(payloads: Map<string, ReturnType<typeof shardBytes>>, calls: FetchCall[]) {
    return resolveConfiguredBitmapShards({
      config: config({ a: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 128 } }),
      catalog: CATALOG,
      version: VERSION,
      descriptorSha256: SHA_A,
      cacheDir: dir,
      io: cacheIo(),
      accessToken: "access-fixture",
      fetch: mockShardApi(payloads, calls),
      allowedHosts: ["r2.example.invalid"],
      now: Date.now(),
    });
  }

  it("fetches only the configured tuples; bearer only to the API", async () => {
    const payloads = payloadsFor([[128, "webp"], [256, "png"]]);
    const calls: FetchCall[] = [];
    const result = await resolveConfiguredBitmapShards({
      config: config({
        a: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 128 },
        b: { styleGroup: "moe-3d-metal", format: "png", imageSize: 256 },
      }),
      catalog: CATALOG,
      version: VERSION,
      descriptorSha256: SHA_A,
      cacheDir: dir,
      io: cacheIo(),
      accessToken: "access-fixture",
      fetch: mockShardApi(payloads, calls),
      allowedHosts: ["r2.example.invalid"],
      now: Date.now(),
    });
    expect(result.requests.map((request) => request.filename)).toEqual([
      "moe-icons-bitmap-pro-moe-3d-metal-128x128-webp-1.2.3.tgz",
      "moe-icons-bitmap-pro-moe-3d-metal-256x256-png-1.2.3.tgz",
    ]);
    expect(result.pins).toHaveLength(2);
    expect(Object.keys(result.files).sort()).toEqual([
      "assets/moe-3d-metal-128-webp/archive-box.webp",
      "assets/moe-3d-metal-256-png/archive-box.png",
    ]);
    expect(calls.filter((call) => call.kind === "api")).toHaveLength(2);
    expect(calls.filter((call) => call.kind === "api").every((call) => call.auth === "Bearer access-fixture")).toBe(true);
    expect(calls.filter((call) => call.kind === "r2").every((call) => call.auth === undefined)).toBe(true);
    expect(result.pins[0]).toMatchObject({
      resourceVersion: VERSION,
      tier: "pro",
      styleGroupId: "moe-3d-metal",
      format: "webp",
      fileCount: 1,
      objectKey: buildBitmapShardObjectKey({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION }),
    });
    expect(result.bitmapShardSetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reuses the verified cache offline and never reads an unselected tuple", async () => {
    const payloads = payloadsFor([[128, "webp"], [512, "png"]]);
    const calls: FetchCall[] = [];
    const fetched = await fetchConfigured(payloads, calls);
    const unselected: BitmapShard = {
      ...fetched.pins[0]!,
      imageSize: { width: 512, height: 512 },
      format: "png",
      filename: buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 512, height: 512 }, format: "png", resourceVersion: VERSION }),
      objectKey: buildBitmapShardObjectKey({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 512, height: 512 }, format: "png", resourceVersion: VERSION }),
    };
    const loaded = loadPinnedBitmapShardAssets([...fetched.pins, unselected], OFFLINE_TUPLE, dir, cacheIo());
    expect(Object.keys(loaded.files)).toEqual(["assets/moe-3d-metal-128-webp/archive-box.webp"]);
  });

  it("fails closed when a selected shard is missing from the cache", async () => {
    const fetched = await fetchConfigured(payloadsFor([[128, "webp"]]), []);
    rmSync(bitmapShardCachePath(dir, bitmapShardVerificationTargetFromPin(fetched.pins[0]!)), { force: true });
    expect(() => loadPinnedBitmapShardAssets(fetched.pins, OFFLINE_TUPLE, dir, cacheIo())).toThrow(/not cached/);
  });

  it("fails closed when the cached bytes are poisoned", async () => {
    const fetched = await fetchConfigured(payloadsFor([[128, "webp"]]), []);
    const cachePath = bitmapShardCachePath(dir, bitmapShardVerificationTargetFromPin(fetched.pins[0]!));
    const poisoned = Uint8Array.from(readFileSync(cachePath));
    poisoned[poisoned.length - 1] = (poisoned[poisoned.length - 1] ?? 0) ^ 0xff;
    writeFileSync(cachePath, poisoned);
    expect(() => loadPinnedBitmapShardAssets(fetched.pins, OFFLINE_TUPLE, dir, cacheIo())).toThrow(/SHA-256 mismatch/);
  });

  it("fails closed when a pin's identity drifts from the cached archive", async () => {
    const fetched = await fetchConfigured(payloadsFor([[128, "webp"]]), []);
    const drifted: BitmapShard = { ...fetched.pins[0]!, sha256: "f".repeat(64) };
    expect(() => loadPinnedBitmapShardAssets([drifted], OFFLINE_TUPLE, dir, cacheIo())).toThrow(/not cached/);
  });
});

describe("DEV-G07 install metadata pins", () => {
  const pin: BitmapShard = {
    schemaVersion: 1,
    resourceVersion: VERSION,
    tier: "pro",
    styleGroupId: "moe-3d-metal",
    imageSize: { width: 128, height: 128 },
    format: "webp",
    filename: buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION }),
    objectKey: buildBitmapShardObjectKey({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION }),
    compressedSize: 10,
    expandedSize: 20,
    sha256: "b".repeat(64),
    fileCount: 1,
    manifestSha256: "c".repeat(64),
  };

  function metadata(overrides: Partial<InstallMetadata> = {}): InstallMetadata {
    const catalog = '{"schemaVersion":1}\n';
    return {
      schemaVersion: 1,
      artifactVersion: VERSION,
      tier: "pro",
      target: "react",
      descriptorSha256: SHA_A,
      artifactSha256: "e".repeat(64),
      catalogSha256: sha256Bytes(catalog),
      installedAt: "2026-08-24T00:00:00.000Z",
      managedFiles: { ".moeicons/catalog.json": sha256Bytes(catalog) },
      bitmapShards: [pin],
      bitmapShardSetSha256: bitmapShardSetSha256([pin]),
      ...overrides,
    };
  }

  it("round-trips pins and rejects a drifted set digest", () => {
    const parsed = parseInstallMetadata(serializeInstallMetadata(metadata()), {});
    expect(parsed?.bitmapShards).toHaveLength(1);
    expect(parsed?.bitmapShardSetSha256).toBe(bitmapShardSetSha256([pin]));
    expect(parseInstallMetadata(serializeInstallMetadata(metadata({ bitmapShardSetSha256: "0".repeat(64) })), {})).toBeUndefined();
    expect(parseInstallMetadata(serializeInstallMetadata(metadata({ bitmapShards: [] })), {})).toBeUndefined();
  });
});

describe("DEV-G07 generate: pinned shards restore bitmap assets", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moe-shard-generate-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fs_ = { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, copyFileSync };

  function projectContext(cacheDir: string): CommandContext {
    return {
      ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) },
      cwd: dir,
      env: { MOEICONS_CACHE_DIR: cacheDir },
      signal: new AbortController().signal,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    };
  }

  function writeConfig(): void {
    writeFileSync(join(dir, "moeicons.config.json"), JSON.stringify({
      schemaVersion: 1, tier: "pro", framework: "react", outputDir: "src/moeicons", defaultTheme: "metal",
      themes: { metal: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 128 } },
      icons: ["archive-box"],
    }));
  }

  it("restores only the pinned variant from the cache without any archive bitmap", async () => {
    const { bytes, manifestSha256, icon } = shardBytes("moe-3d-metal", 128, "webp", ["archive-box"]);
    const pin: BitmapShard = {
      schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId: "moe-3d-metal",
      imageSize: { width: 128, height: 128 }, format: "webp",
      filename: buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION }),
      objectKey: buildBitmapShardObjectKey({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION }),
      compressedSize: bytes.byteLength, expandedSize: icon.byteLength, sha256: sha256(bytes), fileCount: 1, manifestSha256,
    };
    const catalogJson = `${JSON.stringify(CATALOG)}\n`;
    await writeProject(catalogJson, pin);
    const cacheDir = join(dir, ".cache");
    const cachePath = bitmapShardCachePath(cacheDir, bitmapShardVerificationTargetFromPin(pin));
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, bytes);
    writeConfig();
    const result = await runGenerateUseCase(projectContext(cacheDir), fs_, { noTailwind: true, archiveFiles: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toContain("src/moeicons/assets/moe-3d-metal-128-webp/archive-box.webp");
    expect(result.files.some((file) => file.includes("wrappers/"))).toBe(true);
    expect(readFileSync(join(dir, "src/moeicons/assets/moe-3d-metal-128-webp/archive-box.webp"))).toEqual(Buffer.from(icon));
  });

  it("fails closed when a pin is missing from install metadata", async () => {
    const catalogJson = `${JSON.stringify(CATALOG)}\n`;
    await writeProject(catalogJson, undefined);
    writeConfig();
    const result = await runGenerateUseCase(projectContext(join(dir, ".cache")), fs_, { noTailwind: true, archiveFiles: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors?.join(" ")).toMatch(/bitmap shards are not pinned/);
  });

  async function writeProject(catalogJson: string, pin: BitmapShard | undefined): Promise<void> {
    const managedFiles = { ".moeicons/catalog.json": sha256Bytes(catalogJson) };
    const metadata: InstallMetadata = {
      schemaVersion: 1, artifactVersion: VERSION, tier: "pro", target: "react",
      descriptorSha256: SHA_A, artifactSha256: "e".repeat(64), catalogSha256: sha256Bytes(catalogJson),
      installedAt: "2026-08-24T00:00:00.000Z", managedFiles,
      ...(pin ? { bitmapShards: [pin], bitmapShardSetSha256: bitmapShardSetSha256([pin]) } : {}),
    };
    mkdirSync(join(dir, ".moeicons"), { recursive: true });
    writeFileSync(join(dir, ".moeicons", "catalog.json"), catalogJson);
    writeFileSync(join(dir, ".moeicons", "install-metadata.json"), serializeInstallMetadata(metadata));
  }
});
