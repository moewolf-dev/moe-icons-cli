import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGenerateUseCase } from "../src/core/generate.js";
import { main } from "../src/cli.js";
import {
  parseInstallMetadata,
  serializeInstallMetadata,
  sha256Bytes,
} from "../src/project/install-metadata.js";
import type { CommandContext, CommandUi } from "../src/core/context.js";
import type { Target } from "../src/commands/parser.js";

/** Target changes require a matching installed artifact before generation. */

function makeRuntime() {
  const out: string[] = [];
  const err: string[] = [];
  let cwd = "";
  return {
    runtime: {
      cwd: () => cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => false,
      readLine: async () => "",
      readKey: async () => "",
    },
    out,
    err,
    setCwd: (d: string) => {
      cwd = d;
    },
  };
}

function validCatalog(): string {
  return JSON.stringify({
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    sourceVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [{ id: "moe-outline", type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] }],
    icons: [{ id: "ui-search", prefix: "ui", label: "Search", aliases: [], availableIn: ["moe-outline"] }],
  });
}

function writeConfig(dir: string, target: Target, icons: readonly string[] = ["ui-search"]): void {
  writeFileSync(
    join(dir, "moeicons.config.json"),
    JSON.stringify({
      schemaVersion: 2,
      tier: "free",
      target,
      outputDir: "src/moeicons",
      defaultTheme: "outline",
      themes: { outline: { styleGroup: "moe-outline" } },
      icons,
    }),
  );
}

function writeMetadata(dir: string, target: Target): void {
  mkdirSync(join(dir, ".moeicons"), { recursive: true });
  const catalog = validCatalog();
  writeFileSync(join(dir, ".moeicons", "catalog.json"), catalog);
  writeFileSync(
    join(dir, ".moeicons", "install-metadata.json"),
    serializeInstallMetadata({
      schemaVersion: 1,
      artifactVersion: "1.0.0",
      tier: "free",
      target,
      descriptorSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      catalogSha256: sha256Bytes(catalog),
      installedAt: "2026-08-24T00:00:00Z",
      managedFiles: { ".moeicons/catalog.json": sha256Bytes(catalog) },
    }),
  );
}

function makeContext(confirmImpl: () => Promise<boolean | undefined>, cwd = ""): {
  context: CommandContext;
  confirmSpy: ReturnType<typeof vi.fn>;
} {
  const confirmSpy = vi.fn(confirmImpl);
  const ui: CommandUi = {
    select: async () => "free",
    confirm: confirmSpy,
    text: async () => "",
    note() {
      return undefined;
    },
    progress() {
      return { stop() { return undefined; } };
    },
  };
  return {
    context: { ui, cwd, env: {}, signal: new AbortController().signal, now: () => new Date() },
    confirmSpy,
  };
}

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

describe("target-switch install consistency", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "target-switch-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("target switch requires installing the matching artifact before generate", async () => {
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const { context, confirmSpy } = makeContext(async () => true, dir);
    const result = await runGenerateUseCase(context, fs_, { noTailwind: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("moeicons install free --target vue");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "src", "moeicons", "registry.ts"))).toBe(false);
  });

  it("target mismatch returns with zero writes regardless of prompt behavior", async () => {
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const beforeMetadata = readFileSync(join(dir, ".moeicons", "install-metadata.json"), "utf8");
    const { context, confirmSpy } = makeContext(async () => false, dir);
    const result = await runGenerateUseCase(context, fs_, { noTailwind: true });
    if (result.ok) throw new Error("expected a mismatch result");
    expect(result.reason).toContain("moeicons install free --target vue");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
    expect(readFileSync(join(dir, ".moeicons", "install-metadata.json"), "utf8")).toBe(
      beforeMetadata,
    );
  });

  it("--yes cannot generate imports for an uninstalled target", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const code = await main(["generate", "--json", "--yes"], runtime);
    expect(code).toBe(1);
    expect(existsSync(join(dir, "src", "moeicons", "registry.ts"))).toBe(false);
  });

  it("--target override also requires a matching installed artifact", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    writeConfig(dir, "react");
    writeMetadata(dir, "react");
    const code = await main(["generate", "--json", "--yes", "--target", "vue"], runtime);
    expect(code).toBe(1);
  });

  it("non-TTY mismatch reports the install command as a validation error", async () => {
    const { runtime, setCwd, out } = makeRuntime();
    setCwd(dir);
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const code = await main(["generate", "--json"], runtime);
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; code: string; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.message).toContain("moeicons install free --target vue");
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
  });

  it("same-target generate stays silent (no confirmation prompt)", async () => {
    writeConfig(dir, "react");
    writeMetadata(dir, "react");
    const { context, confirmSpy } = makeContext(async () => true, dir);
    const result = await runGenerateUseCase(context, fs_, { noTailwind: true });
    expect(result.ok).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("missing install requires installation without a target confirmation", async () => {
    writeConfig(dir, "vue");
    const { context, confirmSpy } = makeContext(async () => true, dir);
    const result = await runGenerateUseCase(context, fs_, { noTailwind: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("moeicons install");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("reconcile path also rejects an uninstalled target", async () => {
    writeConfig(dir, "vue");
    mkdirSync(join(dir, ".moeicons"), { recursive: true });
    mkdirSync(join(dir, "src", "moeicons"), { recursive: true });
    const catalog = validCatalog();
    writeFileSync(join(dir, ".moeicons", "catalog.json"), catalog);
    writeFileSync(
      join(dir, ".moeicons", "install-metadata.json"),
      serializeInstallMetadata({
        schemaVersion: 1,
        artifactVersion: "1.0.0",
        tier: "free",
        target: "react",
        descriptorSha256: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        catalogSha256: sha256Bytes(catalog),
        installedAt: "2026-08-24T00:00:00Z",
        managedFiles: { ".moeicons/catalog.json": sha256Bytes(catalog) },
      }),
    );
    const { context, confirmSpy } = makeContext(async () => false, dir);
    const result = await runGenerateUseCase(context, fs_, {
      noTailwind: true,
      reconcileInstalled: true,
    });
    if (result.ok) throw new Error("expected a mismatch result");
    expect(result.reason).toContain("moeicons install free --target vue");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, "src", "moeicons")).length).toBe(0);
  });
});
