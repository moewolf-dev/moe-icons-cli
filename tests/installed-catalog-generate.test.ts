import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  readdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGenerateUseCase } from "../src/core/generate.js";
import type { CommandContext, CommandUi } from "../src/core/context.js";
import { serializeInstallMetadata } from "../src/project/install-metadata.js";
import type { IconCatalog } from "../src/catalog/catalog.js";

/**
 * DEV-20-02/BLOCK-15: the SAME verified installed catalog must drive config
 * validation, theme resolution and generation. The audit reproduced an
 * installed catalog with a new bitmap group/icon still failing at generate
 * because only the config read used it. These tests exercise runGenerateUseCase
 * end to end (no catalog module mock).
 */

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

function fakeUi(): CommandUi {
  return {
    select: async () => "pro",
    confirm: async () => true,
    text: async () => "",
    note() {
      return undefined;
    },
    progress() {
      return { stop() { return undefined; } };
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installed-gen-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function bitmapCatalog(): IconCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    sourceVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [
      { id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] },
      {
        id: "moe-3d-metal",
        type: "bitmap",
        tiers: ["pro"],
        formats: ["png", "webp"],
        imageSizes: [256],
        variants: ["moe-3d-metal-256-webp"],
      },
    ],
    icons: [
      { id: "archive-box", prefix: "ar", label: "Archive box", aliases: [], availableIn: ["moe-3d-metal"] },
    ],
  };
}

function writeCatalog(catalog: IconCatalog, metadataHash?: string): void {
  mkdirSync(join(dir, ".moeicons"), { recursive: true });
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  writeFileSync(join(dir, ".moeicons", "catalog.json"), text);
  const hash = metadataHash ?? createHash("sha256").update(text).digest("hex");
  writeFileSync(join(dir, ".moeicons", "install-metadata.json"), serializeInstallMetadata({
    schemaVersion: 1,
    artifactVersion: "1.0.0",
    tier: "pro",
    target: "react",
    descriptorSha256: "c".repeat(64),
    artifactSha256: "d".repeat(64),
    catalogSha256: hash,
    installedAt: "2026-09-11T00:00:00Z",
    managedFiles: { ".moeicons/catalog.json": hash },
  }));
}

function writeConfig(): void {
  writeFileSync(join(dir, "moeicons.config.json"), JSON.stringify({
    schemaVersion: 2,
    tier: "pro",
    target: "react",
    outputDir: "src/moeicons",
    defaultTheme: "metal",
    themes: { metal: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 256 } },
    icons: ["archive-box"],
  }));
}

function context(): CommandContext {
  return { ui: fakeUi(), cwd: dir, env: {}, signal: new AbortController().signal, now: () => new Date("2026-09-11T00:00:00.000Z") };
}

const ARCHIVE = { "assets/moe-3d-metal-256-webp/archive-box.webp": new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01]) };

describe("DEV-20-02 installed catalog drives generation", () => {
  it("generates an icon that exists only in the installed catalog", async () => {
    writeCatalog(bitmapCatalog());
    writeConfig();
    const result = await runGenerateUseCase(context(), fs_, { noTailwind: true, archiveFiles: ARCHIVE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toContain("src/moeicons/wrappers/MetalArchiveBoxBitmap.tsx");
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(true);
  });

  it("fails closed on a corrupt installed catalog instead of silently using bundled", async () => {
    mkdirSync(join(dir, ".moeicons"), { recursive: true });
    writeFileSync(join(dir, ".moeicons", "catalog.json"), "{not json");
    writeConfig();
    const result = await runGenerateUseCase(context(), fs_, { noTailwind: true, archiveFiles: ARCHIVE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors?.[0]).toMatch(/installed catalog/);
  });

  it("fails closed when the installed catalog hash drifts from install metadata", async () => {
    writeCatalog(bitmapCatalog(), "f".repeat(64));
    writeConfig();
    const result = await runGenerateUseCase(context(), fs_, { noTailwind: true, archiveFiles: ARCHIVE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors?.[0]).toMatch(/does not match install metadata/);
  });

  it("uses the bundled catalog when no installed catalog exists", async () => {
    writeConfig();
    const result = await runGenerateUseCase(context(), fs_, { noTailwind: true, archiveFiles: ARCHIVE });
    // moe-3d-metal is unknown to the bundled catalog, so this must fail closed.
    expect(result.ok).toBe(false);
  });
});
