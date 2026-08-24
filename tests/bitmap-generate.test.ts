import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  renameSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/catalog/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/catalog/catalog.js")>();
  return {
    ...actual,
    findCatalogStyleGroup: (id: string) => {
      if (id === "moe-cute-3d") {
        return {
          id: "moe-cute-3d",
          type: "bitmap" as const,
          tiers: ["free", "pro"] as const,
          formats: ["webp", "png"] as const,
          imageSizes: [64, 128, 256, 512],
        };
      }
      return actual.findCatalogStyleGroup(id);
    },
    findCatalogIcon: (id: string) => {
      const found = actual.findCatalogIcon(id);
      if (!found) return undefined;
      if (found.availableIn.includes("moe-cute-3d")) return found;
      return { ...found, availableIn: [...found.availableIn, "moe-cute-3d"] };
    },
  };
});

import { matchArchiveBitmapFile, selectBitmapVariantAssets } from "../src/core/bitmap-assets.js";
import { planGeneratedFiles } from "../src/generator/generate.js";
import { executeGeneratedFilesDir } from "../src/project/install.js";
import { runGenerateUseCase } from "../src/core/generate.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";
import type { CommandContext, CommandUi } from "../src/core/context.js";
import { resolveResourceVariant } from "../src/core/resource-variant.js";

const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01]);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02]);

function archiveWithBothVariants(): Record<string, Uint8Array> {
  return {
    "assets/moe-cute-3d-webp-256/arrow-bold-right.webp": webpBytes,
    "assets/moe-cute-3d-png-512/arrow-bold-right.png": pngBytes,
    "assets/moe-cute-3d-webp-256/other-icon.webp": new Uint8Array([0x03]),
  };
}

function bitmapConfig(overrides: Partial<MoeiconsConfigFile> = {}): MoeiconsConfigFile {
  return {
    schemaVersion: 1,
    tier: "free",
    framework: "react",
    outputDir: "src/moeicons",
    defaultTheme: "cute",
    themes: {
      cute: { styleGroup: "moe-cute-3d", format: "webp", imageSize: 256, className: "w-8 h-8" },
    },
    icons: ["arrow-bold-right"],
    missingIconPolicy: "fallback",
    ...overrides,
  };
}

function fakeUi(): CommandUi {
  return {
    select: async () => "free",
    confirm: async () => true,
    text: async () => "",
    note() {
      return undefined;
    },
    progress() {
      return {
        stop() {
          return undefined;
        },
      };
    },
  };
}

describe("bitmap asset selection (G5)", () => {
  it("matches archive paths by parsing a directory segment as resourceVariantId", () => {
    expect(matchArchiveBitmapFile("moe-cute-3d-webp-256/ui-search.webp")).toMatchObject({
      iconId: "ui-search",
      variant: { resourceVariantId: "moe-cute-3d-webp-256" },
    });
    expect(matchArchiveBitmapFile("prefix/assets/moe-cute-3d-png-512/ui-search.png")?.variant.resourceVariantId).toBe(
      "moe-cute-3d-png-512",
    );
    expect(matchArchiveBitmapFile("catalog.json")).toBeUndefined();
  });

  it("keeps only the requested variant and selected icons", () => {
    const variant = resolveResourceVariant("moe-cute-3d", { format: "webp", imageSize: 256 });
    const selected = selectBitmapVariantAssets(archiveWithBothVariants(), [variant], ["arrow-bold-right"]);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.assets).toHaveLength(1);
    expect(selected.assets[0]?.destRel).toBe("assets/moe-cute-3d-webp-256/arrow-bold-right.webp");
    expect(selected.assets[0]?.bytes).toEqual(webpBytes);
    expect(selected.skipped.some((path) => path.includes("png-512"))).toBe(true);
    expect(selected.skipped.some((path) => path.includes("other-icon"))).toBe(true);
  });

  it("errors when a selected icon is missing from the requested variant", () => {
    const variant = resolveResourceVariant("moe-cute-3d", { format: "webp", imageSize: 256 });
    const selected = selectBitmapVariantAssets(
      { "assets/moe-cute-3d-png-512/arrow-bold-right.png": pngBytes },
      [variant],
      ["arrow-bold-right"],
    );
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.errors[0]).toMatch(/bitmap asset missing/);
  });
});

describe("bitmap wrapper + asset plan (G4/G5)", () => {
  it("keeps logical themes and lands only the selected variant bytes in the plan", () => {
    const config = bitmapConfig({
      themes: {
        cute: { styleGroup: "moe-cute-3d", format: "webp", imageSize: 256, className: "w-8 h-8" },
        outline: { styleGroup: "moe-outline", className: "text-zinc-700" },
      },
    });
    const plan = planGeneratedFiles(config, "src/moeicons", { archiveFiles: archiveWithBothVariants() });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.files.map((file) => file.path);
    expect(paths.some((path) => path.includes("wrappers/CuteArrowBoldRightBitmap.tsx"))).toBe(true);
    expect(paths).toContain("src/moeicons/assets/moe-cute-3d-webp-256/arrow-bold-right.webp");
    expect(paths.some((path) => path.includes("png-512"))).toBe(false);
    const asset = plan.files.find((file) => file.path.endsWith("arrow-bold-right.webp"));
    expect(asset?.content).toEqual(webpBytes);
    const registry = plan.files.find((file) => file.path.endsWith("registry.ts"))?.content ?? "";
    expect(typeof registry).toBe("string");
    expect(registry).toContain('"cute"');
    expect(registry).not.toContain('"moe-cute-3d-webp-256"');
  });

  it("rejects bitmap plans without an archive instead of silently skipping assets", () => {
    const plan = planGeneratedFiles(bitmapConfig(), "src/moeicons");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.some((error) => /downloaded free artifact|archive/i.test(error))).toBe(true);
  });

  it("rejects missing assets before any generate write", () => {
    const plan = planGeneratedFiles(bitmapConfig(), "src/moeicons", {
      archiveFiles: { "assets/moe-cute-3d-png-512/arrow-bold-right.png": pngBytes },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors[0]).toMatch(/bitmap asset missing/);
  });
});

describe("bitmap assets transaction (G5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bitmap-gen-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fs_ = {
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    renameSync,
    rmSync,
    readdirSync,
    copyFileSync,
  };

  it("writes only the selected variant and drops stale assets/ on regenerate", () => {
    const output = join(dir, "src", "moeicons");
    mkdirSync(join(output, "assets", "moe-cute-3d-png-512"), { recursive: true });
    writeFileSync(join(output, "assets", "moe-cute-3d-png-512", "arrow-bold-right.png"), Buffer.from(pngBytes));
    writeFileSync(join(output, "user-note.md"), "keep me");

    const plan = planGeneratedFiles(bitmapConfig(), "src/moeicons", { archiveFiles: archiveWithBothVariants() });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    executeGeneratedFilesDir(plan.files, dir, "src/moeicons", fs_);

    expect(existsSync(join(output, "assets", "moe-cute-3d-webp-256", "arrow-bold-right.webp"))).toBe(true);
    expect(readFileSync(join(output, "assets", "moe-cute-3d-webp-256", "arrow-bold-right.webp"))).toEqual(
      Buffer.from(webpBytes),
    );
    expect(existsSync(join(output, "assets", "moe-cute-3d-png-512", "arrow-bold-right.png"))).toBe(false);
    expect(readFileSync(join(output, "user-note.md"), "utf8")).toBe("keep me");
  });

  it("runGenerateUseCase fails closed when bitmap themes lack an archive", () => {
    writeFileSync(
      join(dir, "moeicons.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        tier: "free",
        framework: "react",
        outputDir: "src/moeicons",
        defaultTheme: "cute",
        themes: { cute: { styleGroup: "moe-cute-3d", format: "webp", imageSize: 256 } },
        icons: ["arrow-bold-right"],
      }),
    );
    const context: CommandContext = {
      ui: fakeUi(),
      cwd: dir,
      env: {},
      signal: new AbortController().signal,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    };
    const result = runGenerateUseCase(context, fs_, { noTailwind: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("validation");
    expect(result.errors?.[0]).toMatch(/downloaded free artifact|MOEICONS_BITMAP_ARCHIVE/);
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
  });
});
