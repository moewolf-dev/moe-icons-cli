import { describe, expect, it } from "vitest";
import {
  assetRelativePath,
  buildResourceVariantId,
  parseBitmapName,
  parseLegacyResourceVariantId,
  parseResourceVariantId,
  resolveResourceVariant,
} from "../src/core/resource-variant.js";

describe("resourceVariantId (MEDIA-FORMAT-V2)", () => {
  it("builds canonical actual-directory ids (<group>-<size>-<format>)", () => {
    expect(buildResourceVariantId("moe-3d-metal")).toBe("moe-3d-metal-256-webp");
    expect(buildResourceVariantId("moe-3d-metal", "png", 128)).toBe("moe-3d-metal-128-png");
    expect(buildResourceVariantId("moe-cute-3d", "webp", 512)).toBe("moe-cute-3d-512-webp");
  });

  it("accepts 3d anywhere and parses by complete keyword tokens", () => {
    expect(parseResourceVariantId("moe-3d-metal-256-webp")).toEqual({
      styleGroupId: "moe-3d-metal",
      format: "webp",
      imageSize: 256,
      resourceVariantId: "moe-3d-metal-256-webp",
    });
    expect(parseResourceVariantId("moe-3d-metal-128-png").styleGroupId).toBe("moe-3d-metal");
    expect(parseResourceVariantId("moe-cute-3d-512-png").styleGroupId).toBe("moe-cute-3d");
  });

  it("does not guess: legacy order, vector names and bare substrings are not v2", () => {
    expect(parseBitmapName("moe-3d-metal-webp-256")).toBeUndefined();
    expect(parseBitmapName("moe-outline")).toBeUndefined();
    expect(parseBitmapName("moe-3d-metal-pngish")).toBeUndefined();
    expect(parseBitmapName("moe-3d-metal-gif-256")).toBeUndefined();
    expect(() => parseResourceVariantId("moe-cute-3d-webp-256")).toThrow(/invalid/);
  });

  it("fails closed on duplicate/conflicting keywords", () => {
    expect(() => parseResourceVariantId("moe-3d-metal-256-png-webp")).toThrow(/exactly one format token/);
    expect(() => parseResourceVariantId("moe-3d-metal-128-256-png")).toThrow(/exactly one format token and one size token/);
    expect(() => parseResourceVariantId("moe-3d-metal-png")).toThrow(/exactly one/);
  });

  it("reads frozen v1 artifacts only through the explicit legacy parser", () => {
    expect(parseLegacyResourceVariantId("moe-cute-3d-webp-256")).toEqual({
      styleGroupId: "moe-cute-3d",
      format: "webp",
      imageSize: 256,
      resourceVariantId: "moe-cute-3d-webp-256",
    });
    expect(() => parseLegacyResourceVariantId("moe-outline-webp-256")).toThrow(/legacy styleGroupId/);
    expect(() => parseLegacyResourceVariantId("moe-cute-3d-gif-256")).toThrow(/format/);
  });

  it("resolves omitted format/size to webp/256", () => {
    expect(resolveResourceVariant("moe-3d-metal")).toMatchObject({
      format: "webp",
      imageSize: 256,
      resourceVariantId: "moe-3d-metal-256-webp",
    });
    expect(resolveResourceVariant("moe-3d-metal", { format: "png", imageSize: 512 }).resourceVariantId).toBe(
      "moe-3d-metal-512-png",
    );
  });

  it("builds POSIX asset paths under outputDir/assets", () => {
    expect(assetRelativePath("moe-3d-metal-256-webp", "ui-search", "webp")).toBe(
      "assets/moe-3d-metal-256-webp/ui-search.webp",
    );
  });
});
