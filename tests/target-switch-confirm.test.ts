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

/**
 * B5: switching the configured target over an existing install is a destructive
 * migration. Interactive TTY requires explicit confirmation; non-interactive /
 * --json fails with VALIDATION_ERROR unless --yes is passed. Fresh installs
 * never prompt, and same-target generation stays silent.
 */

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
  writeFileSync(join(dir, ".moeicons", "catalog.json"), "catalog");
  writeFileSync(
    join(dir, ".moeicons", "install-metadata.json"),
    serializeInstallMetadata({
      schemaVersion: 1,
      artifactVersion: "1.0.0",
      tier: "free",
      target,
      descriptorSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      catalogSha256: sha256Bytes("catalog"),
      installedAt: "2026-08-24T00:00:00Z",
      managedFiles: { ".moeicons/catalog.json": sha256Bytes("catalog") },
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

describe("B5: destructive target-switch confirmation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "target-switch-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("target switch requires an explicit confirmation and proceeds on yes", async () => {
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const { context, confirmSpy } = makeContext(async () => true, dir);
    const result = await runGenerateUseCase(context, fs_, { noTailwind: true });
    expect(result.ok).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/react.*vue|switch/i);
    expect(existsSync(join(dir, "src", "moeicons", "registry.ts"))).toBe(true);
  });

  it("declined target switch returns cancelled with zero writes", async () => {
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const beforeMetadata = readFileSync(join(dir, ".moeicons", "install-metadata.json"), "utf8");
    const { context, confirmSpy } = makeContext(async () => false, dir);
    const result = await runGenerateUseCase(context, fs_, { noTailwind: true });
    if (result.ok) throw new Error("expected a cancelled result");
    expect(result.reason).toBe("cancelled");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "src", "moeicons"))).toBe(false);
    expect(readFileSync(join(dir, ".moeicons", "install-metadata.json"), "utf8")).toBe(
      beforeMetadata,
    );
  });

  it("--yes allows the switch in non-interactive mode", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const code = await main(["generate", "--json", "--yes"], runtime);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "src", "moeicons", "registry.ts"))).toBe(true);
  });

  it("--target override switch also passes with --yes", async () => {
    const { runtime, setCwd } = makeRuntime();
    setCwd(dir);
    writeConfig(dir, "react");
    writeMetadata(dir, "react");
    const code = await main(["generate", "--json", "--yes", "--target", "vue"], runtime);
    expect(code).toBe(0);
  });

  it("non-TTY without --yes fails with VALIDATION_ERROR", async () => {
    const { runtime, setCwd, out } = makeRuntime();
    setCwd(dir);
    writeConfig(dir, "vue");
    writeMetadata(dir, "react");
    const code = await main(["generate", "--json"], runtime);
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("")) as { ok: boolean; code: string; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.message).toMatch(/confirmation/i);
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

  it("fresh install with no metadata requires no confirmation", async () => {
    writeConfig(dir, "vue");
    const { context, confirmSpy } = makeContext(async () => true, dir);
    const result = await runGenerateUseCase(context, fs_, { noTailwind: true });
    expect(result.ok).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("reconcile path also prompts on a target switch", async () => {
    writeConfig(dir, "vue");
    mkdirSync(join(dir, ".moeicons"), { recursive: true });
    mkdirSync(join(dir, "src", "moeicons"), { recursive: true });
    writeFileSync(join(dir, ".moeicons", "catalog.json"), "catalog");
    writeFileSync(
      join(dir, ".moeicons", "install-metadata.json"),
      serializeInstallMetadata({
        schemaVersion: 1,
        artifactVersion: "1.0.0",
        tier: "free",
        target: "react",
        descriptorSha256: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        catalogSha256: sha256Bytes("catalog"),
        installedAt: "2026-08-24T00:00:00Z",
        managedFiles: { ".moeicons/catalog.json": sha256Bytes("catalog") },
      }),
    );
    const { context, confirmSpy } = makeContext(async () => false, dir);
    const result = await runGenerateUseCase(context, fs_, {
      noTailwind: true,
      reconcileInstalled: true,
    });
    if (result.ok) throw new Error("expected a cancelled result");
    expect(result.reason).toBe("cancelled");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(dir, "src", "moeicons")).length).toBe(0);
  });
});
