import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTarGz } from "../src/project/tar-gz.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";
import type { IconCatalog } from "../src/catalog/catalog.js";
import {
  resolveBitmapTuples,
  planBitmapShardRequests,
  shardAssetsToLocalLayout,
  fetchSelectedBitmapShards,
} from "../src/core/bitmap-shard-resolver.js";
import {
  buildBitmapShardFilename,
} from "../src/core/bitmap-shards.js";

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
      imageSizes: [128, 256],
      variants: ["moe-3d-metal-128-webp", "moe-3d-metal-128-png", "moe-3d-metal-256-webp", "moe-3d-metal-256-png"],
    },
  ],
  icons: [
    { id: "archive-box", prefix: "archive", label: "Archive Box", aliases: [], availableIn: ["moe-outline", "moe-3d-metal"], targets: ["react"] },
  ],
};

function config(themes: Record<string, { styleGroup: string; format?: "webp" | "png"; imageSize?: 64 | 128 | 256 | 512 }>): MoeiconsConfigFile {
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

function shardBytes(styleGroupId: string, width: number, format: "webp" | "png", icons: string[]) {
  const icon = format === "webp" ? makeWebp(width, width) : makePng(width, width);
  const files = icons.map((iconId) => ({ iconId, path: `icons/${iconId}.${format}`, byteSize: icon.length, sha256: sha256(icon) }));
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, resourceVersion: VERSION, tier: "pro", styleGroupId,
    imageSize: { width, height: width }, format, iconCount: icons.length, files,
  })}\n`);
  const tar = { "manifest.json": manifest } as Record<string, Uint8Array>;
  for (const file of files) tar[file.path] = icon;
  return { bytes: createTarGz(tar), manifestSha256: sha256(manifest) };
}

describe("bitmap shard resolver (DEV-G07)", () => {
  it("dedupes and canonically sorts configured tuples", () => {
    const result = resolveBitmapTuples(config({
      a: { styleGroup: "moe-3d-metal", format: "png", imageSize: 256 },
      b: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 128 },
      c: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 128 },
      svg: { styleGroup: "moe-outline" },
    }), CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tuples.map((t) => `${t.styleGroupId}/${t.imageSize.width}/${t.format}`)).toEqual([
      "moe-3d-metal/128/webp",
      "moe-3d-metal/256/png",
    ]);
  });

  it("fails closed on an unavailable variant", () => {
    const result = resolveBitmapTuples(config({ a: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 512 } }), CATALOG);
    expect(result.ok).toBe(false);
  });

  it("plans one immutable request per tuple in canonical order", () => {
    const requests = planBitmapShardRequests([
      { styleGroupId: "moe-3d-metal", imageSize: { width: 256, height: 256 }, format: "png" },
      { styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp" },
    ], VERSION);
    expect(requests.map((r) => r.filename)).toEqual([
      "moe-icons-bitmap-pro-moe-3d-metal-128x128-webp-1.2.3.tgz",
      "moe-icons-bitmap-pro-moe-3d-metal-256x256-png-1.2.3.tgz",
    ]);
    expect(requests[0]!.objectKey).toContain("/bitmap-shards/moe-3d-metal/128x128/webp/");
    expect(new Set(requests.map((r) => r.objectKey)).size).toBe(2);
  });

  it("maps verified shard bytes back to the canonical assets layout", () => {
    const { bytes, manifestSha256 } = shardBytes("moe-3d-metal", 128, "webp", ["archive-box", "ui-search"]);
    const descriptor = {
      tier: "pro" as const, version: VERSION, descriptorSha256: SHA_A,
      styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp" as const,
      filename: buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: VERSION }),
      url: "https://r2.example.invalid/x?X-Amz-Signature=s", expiresAt: "2099-01-01T00:00:00.000Z",
      size: bytes.byteLength, sha256: sha256(bytes), manifestSha256,
    };
    // Re-verify through the public download verifier path indirectly:
    const layout = shardAssetsToLocalLayout({ descriptor, files: { "icons/archive-box.webp": bytes, "icons/ui-search.webp": bytes }, iconIds: ["archive-box", "ui-search"] } as never);
    expect(Object.keys(layout).sort()).toEqual([
      "assets/moe-3d-metal-128-webp/archive-box.webp",
      "assets/moe-3d-metal-128-webp/ui-search.webp",
    ]);
  });

  it("fetches only the selected shards, bearer only to the API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moe-resolver-"));
    const apiCalls: Array<{ url: string; auth?: string | undefined }> = [];
    const r2Calls: Array<{ url: string; auth?: string | undefined }> = [];
    const payloads = new Map<string, { bytes: Uint8Array; manifestSha256: string }>();
    for (const [width, format] of [[128, "webp"], [256, "png"]] as const) {
      payloads.set(`${width}-${format}`, shardBytes("moe-3d-metal", width, format, ["archive-box"]));
    }
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = init?.headers ? new Headers(init.headers).get("authorization") ?? undefined : undefined;
      if (url.includes("/bitmap-shard-descriptor")) {
        apiCalls.push({ url, auth });
        const body = JSON.parse(String(init?.body)) as { styleGroupId: string; imageSize: { width: number }; format: "webp" | "png" };
        const entry = payloads.get(`${body.imageSize.width}-${body.format}`)!;
        const filename = buildBitmapShardFilename({ tier: "pro", styleGroupId: body.styleGroupId, imageSize: { width: body.imageSize.width, height: body.imageSize.width }, format: body.format, resourceVersion: VERSION });
        return Response.json({
          tier: "pro", version: VERSION, descriptorSha256: SHA_A, styleGroupId: body.styleGroupId,
          imageSize: { width: body.imageSize.width, height: body.imageSize.width }, format: body.format,
          filename, url: `https://r2.example.invalid/${encodeURIComponent(filename)}?X-Amz-Signature=s`,
          expiresAt: "2099-01-01T00:00:00.000Z", size: entry.bytes.byteLength, sha256: sha256(entry.bytes), manifestSha256: entry.manifestSha256,
        });
      }
      r2Calls.push({ url, auth });
      const filename = decodeURIComponent(url.split("/").pop()!.split("?")[0]!);
      const match = [...payloads.entries()].find(([key]) => {
        const [, format] = key.split("-");
        return buildBitmapShardFilename({ tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: Number(key.split("-")[0]), height: Number(key.split("-")[0]) }, format: format as "webp" | "png", resourceVersion: VERSION }) === filename;
      });
      return new Response(match ? match[1].bytes : null, { status: match ? 200 : 404 });
    }) as typeof fetch;

    try {
      const resolved = await fetchSelectedBitmapShards([
        { styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp" },
        { styleGroupId: "moe-3d-metal", imageSize: { width: 256, height: 256 }, format: "png" },
      ], {
        version: VERSION,
        descriptorSha256: SHA_A,
        accessToken: "access-fixture",
        cacheDir: dir,
        io: {
          mkdirSync: (p) => mkdirSync(p, { recursive: true }),
          writeFileSync: (p, data) => writeFileSync(p, data),
          renameSync: (from, to) => renameSync(from, to),
          existsSync: (p) => existsSync(p),
          rmSync: (p, o) => rmSync(p, o),
          readFileSync: (p) => readFileSync(p),
          readdirSync: (p) => readdirSync(p),
        },
        allowedHosts: ["r2.example.invalid"],
        fetch: fetchMock,
        now: Date.now(),
      });
      expect(resolved.shards).toHaveLength(2);
      expect(Object.keys(resolved.files).sort()).toEqual([
        "assets/moe-3d-metal-128-webp/archive-box.webp",
        "assets/moe-3d-metal-256-png/archive-box.png",
      ]);
      expect(apiCalls).toHaveLength(2);
      expect(apiCalls.every((call) => call.auth === "Bearer access-fixture")).toBe(true);
      expect(r2Calls).toHaveLength(2);
      expect(r2Calls.every((call) => call.auth === undefined)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
