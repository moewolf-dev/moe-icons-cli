import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findProjectRoot,
  detectPackageManager,
  detectWorkspace,
  detectProject,
  assertWritableProject,
} from "../src/project/detect.js";
import { readMoeiconsConfig, mergeMoeiconsConfig } from "../src/project/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-proj-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("finds the nearest package.json walking up", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    expect(findProjectRoot(join(dir, "a", "b"))).toBe(dir);
  });

  it("returns undefined at filesystem root without package.json", () => {
    expect(findProjectRoot("/Volumes/")).toBeUndefined();
  });

  it("returns the directory for a direct package.json", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    expect(findProjectRoot(dir)).toBe(dir);
  });
});

describe("detectPackageManager", () => {
  it("detects pnpm from lockfile", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("returns unknown on conflicting lockfiles", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    writeFileSync(join(dir, "package-lock.json"), "");
    expect(detectPackageManager(dir)).toBe("unknown");
  });

  it("detects npm", () => {
    writeFileSync(join(dir, "package-lock.json"), "");
    expect(detectPackageManager(dir)).toBe("npm");
  });
});

describe("detectWorkspace", () => {
  it("reads npm workspaces from package.json", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    expect(detectWorkspace(dir)).toContain("packages/*");
  });

  it("reads pnpm-workspace.yaml", () => {
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n  - 'libs/*'\n");
    expect(detectWorkspace(dir)).toEqual(["apps/*", "libs/*"]);
  });
});

describe("detectProject", () => {
  it("returns a full detection", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(dir, "package-lock.json"), "");
    const project = detectProject(dir);
    expect(project?.root).toBe(dir);
    expect(project?.packageManager).toBe("npm");
    expect(project?.workspaceMembers).toContain("packages/*");
  });
});

describe("assertWritableProject", () => {
  it("rejects node_modules targets", () => {
    expect(assertWritableProject(dir, join(dir, "node_modules", "x"), []).length).toBeGreaterThan(0);
  });

  it("rejects targets outside the workspace", () => {
    expect(assertWritableProject(dir, "/elsewhere/x", ["packages/*"]).length).toBeGreaterThan(0);
  });
});

describe("readMoeiconsConfig / mergeMoeiconsConfig", () => {
  it("returns missing when absent", () => {
    expect(readMoeiconsConfig(dir).kind).toBe("missing");
  });

  it("parses a valid JSON config", () => {
    writeFileSync(
      join(dir, "moeicons.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        tier: "free",
        framework: "react",
        outputDir: "src/moeicons",
        defaultTheme: "outline",
        themes: { outline: { styleGroup: "moe-outline", styles: ["outline"] } },
        icons: ["ui-search"],
      }),
    );
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.config.framework).toBe("react");
    }
  });

  it("rejects an unsupported version", () => {
    writeFileSync(join(dir, "moeicons.config.json"), JSON.stringify({ schemaVersion: 99 }));
    expect(readMoeiconsConfig(dir).kind).toBe("unsupported");
  });

  it("rejects invalid config", () => {
    writeFileSync(join(dir, "moeicons.config.json"), "{not json");
    expect(readMoeiconsConfig(dir).kind).toBe("invalid");
  });

  it("merges patches preserving unrelated fields", () => {
    const base = {
      schemaVersion: 1 as const,
      tier: "free" as const,
      framework: "react" as const,
      outputDir: "src/moeicons",
      defaultTheme: "outline",
      themes: { outline: { styleGroup: "moe-outline", styles: ["outline"] } },
      icons: ["ui-search"],
    };
    const merged = mergeMoeiconsConfig(base, { outputDir: "lib/moeicons" });
    expect(merged.outputDir).toBe("lib/moeicons");
    expect(merged.framework).toBe("react");
    expect(merged.icons).toEqual(["ui-search"]);
  });
});
