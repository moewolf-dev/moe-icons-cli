import { describe, expect, it } from "vitest";
import {
  assetRelativePath,
  buildResourceVariantId,
  isBitmapStyleGroupId,
  parseResourceVariantId,
  resolveResourceVariant,
} from "../src/core/resource-variant.js";

describe("resourceVariantId (G1/G2)", () => {
  it("accepts bitmap style group ids ending in -3d", () => {
    expect(isBitmapStyleGroupId("moe-cute-3d")).toBe(true);
    expect(isBitmapStyleGroupId("moe-outline")).toBe(false);
    expect(isBitmapStyleGroupId("moe-cute-3d-extra")).toBe(false);
  });

  it("builds deterministic variant ids with defaults webp/256", () => {
    expect(buildResourceVariantId("moe-cute-3d")).toBe("moe-cute-3d-webp-256");
    expect(buildResourceVariantId("moe-cute-3d", "png", 128)).toBe("moe-cute-3d-png-128");
  });

  it("parses from the right and keeps styleGroupId intact when it contains -3d", () => {
    expect(parseResourceVariantId("moe-cute-3d-webp-256")).toEqual({
      styleGroupId: "moe-cute-3d",
      format: "webp",
      imageSize: 256,
      resourceVariantId: "moe-cute-3d-webp-256",
    });
    expect(parseResourceVariantId("moe-pixel-lite-3d-png-64").styleGroupId).toBe("moe-pixel-lite-3d");
  });

  it("rejects guessing by mid-string -3d and rejects invalid tokens", () => {
    expect(() => parseResourceVariantId("moe-cute-3d")).toThrow(/invalid/);
    expect(() => parseResourceVariantId("moe-outline-webp-256")).toThrow(/styleGroupId/);
    expect(() => parseResourceVariantId("moe-cute-3d-gif-256")).toThrow(/format/);
    expect(() => parseResourceVariantId("moe-cute-3d-webp-48")).toThrow(/imageSize/);
  });

  it("resolves omitted format/size to catalog defaults", () => {
    expect(resolveResourceVariant("moe-cute-3d")).toMatchObject({
      format: "webp",
      imageSize: 256,
      resourceVariantId: "moe-cute-3d-webp-256",
    });
    expect(resolveResourceVariant("moe-cute-3d", { format: "png", imageSize: 512 }).resourceVariantId).toBe(
      "moe-cute-3d-png-512",
    );
  });

  it("builds POSIX asset paths under outputDir/assets", () => {
    expect(assetRelativePath("moe-cute-3d-webp-256", "ui-search", "webp")).toBe(
      "assets/moe-cute-3d-webp-256/ui-search.webp",
    );
  });
});
