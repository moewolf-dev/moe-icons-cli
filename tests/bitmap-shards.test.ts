import { describe, expect, it } from "vitest";
import {
  buildBitmapShardFilename,
  buildBitmapShardObjectKey,
  parseBitmapShardFilename,
  parseBitmapShard,
  bitmapShardSetSha256,
  sortBitmapShards,
  validateBitmapShardSet,
  assertBitmapShardSetSha256,
  canonicalJson,
  type BitmapShard,
} from "../src/core/bitmap-shards.js";

const RV = "0.0.17";
const SHA = "a".repeat(64);

function makeShard(overrides: Partial<BitmapShard> = {}): BitmapShard {
  const tuple = {
    tier: "pro" as const,
    styleGroupId: "moe-3d-metal",
    imageSize: { width: 128, height: 128 },
    format: "webp" as const,
    resourceVersion: RV,
    ...overrides,
  };
  const filename = buildBitmapShardFilename(tuple);
  return {
    schemaVersion: 1,
    resourceVersion: RV,
    tier: tuple.tier,
    styleGroupId: tuple.styleGroupId,
    imageSize: tuple.imageSize,
    format: tuple.format,
    filename,
    objectKey: buildBitmapShardObjectKey({ ...tuple, filename }),
    compressedSize: 100,
    expandedSize: 200,
    sha256: SHA,
    fileCount: 3,
    manifestSha256: SHA,
    ...overrides,
  };
}

describe("bitmap shard contract (CLI)", () => {
  it("builds canonical filenames/keys and round-trips", () => {
    const filename = buildBitmapShardFilename({
      tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: RV,
    });
    expect(filename).toBe("moe-icons-bitmap-pro-moe-3d-metal-128x128-webp-0.0.17.tgz");
    expect(parseBitmapShardFilename(filename)).toEqual({
      tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 128, height: 128 }, format: "webp", resourceVersion: RV,
    });
    expect(parseBitmapShardFilename("moe-icons-bitmap-pro-moe-3d-metal-128x256-webp-0.0.17.tgz")).toBeUndefined();
    expect(buildBitmapShardObjectKey({
      tier: "pro", styleGroupId: "moe-3d-metal", imageSize: { width: 256, height: 256 }, format: "png", resourceVersion: RV,
    })).toBe("moeicons/v1/releases/0.0.17/pro/bitmap-shards/moe-3d-metal/256x256/png/moe-icons-bitmap-pro-moe-3d-metal-256x256-png-0.0.17.tgz");
  });

  it("rejects non-canonical shards and set drift", () => {
    const good = makeShard();
    expect(parseBitmapShard(good).filename).toBe(good.filename);
    expect(() => parseBitmapShard({ ...good, filename: "x.tgz" })).toThrow(/filename/);
    expect(() => parseBitmapShard({ ...good, fileCount: 0 })).toThrow(/fileCount/);
    const b = makeShard({ imageSize: { width: 256, height: 256 }, format: "png" });
    const expected = bitmapShardSetSha256([good, b]);
    expect(validateBitmapShardSet([good, b], { resourceVersion: RV }).shards).toHaveLength(2);
    expect(assertBitmapShardSetSha256([good, b], expected)).toBe(expected);
    expect(() => validateBitmapShardSet([b, good], { resourceVersion: RV })).toThrow(/canonical order/);
    expect(() => validateBitmapShardSet([good, good], { resourceVersion: RV })).toThrow(/duplicate/);
  });

  it("sorts deterministically and hashes canonically", () => {
    const sorted = sortBitmapShards([
      makeShard({ styleGroupId: "moe-b", format: "png" }),
      makeShard({ imageSize: { width: 256, height: 256 }, format: "png" }),
      makeShard({ format: "png" }),
      makeShard({ format: "webp" }),
    ]).map((s) => `${s.styleGroupId}/${s.imageSize.width}/${s.format}`);
    expect(sorted).toEqual(["moe-3d-metal/128/png", "moe-3d-metal/128/webp", "moe-3d-metal/256/png", "moe-b/128/png"]);
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});
