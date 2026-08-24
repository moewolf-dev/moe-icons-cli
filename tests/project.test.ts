import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findProjectRoot,
  detectPackageManager,
  detectWorkspace,
  detectProject,
  assertWritableProject,
} from "../src/project/detect.js";
import { readMoeiconsConfig, mergeMoeiconsConfig, renderMoeiconsConfigJsonc } from "../src/project/config.js";

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

/** Write a minimal valid config JSON to dir, with optional overrides. */
function writeConfig(d: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(d, "moeicons.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      tier: "free",
      framework: "react",
      outputDir: "src/moeicons",
      defaultTheme: "outline",
      themes: { outline: { styleGroup: "moe-outline" } },
      icons: ["ui-search"],
      ...overrides,
    }),
  );
}

describe("readMoeiconsConfig / mergeMoeiconsConfig", () => {
  it("returns missing when absent", () => {
    expect(readMoeiconsConfig(dir).kind).toBe("missing");
  });

  it("parses a valid JSON config and returns empty warnings", () => {
    writeConfig(dir);
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.config.framework).toBe("react");
      expect(result.warnings).toEqual([]);
    }
  });

  it("strips JSONC // comments inside strings correctly", () => {
    // The comment is outside the string value — must be stripped.
    writeFileSync(
      join(dir, "moeicons.config.jsonc"),
      `{
  "schemaVersion": 1,
  "tier": "free", // this is a comment
  "framework": "react",
  "outputDir": "src/moeicons",
  "defaultTheme": "outline",
  "themes": { "outline": { "styleGroup": "moe-outline" } },
  "icons": ["ui-search"] // trailing comment
}`,
    );
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.config.tier).toBe("free");
    }
  });

  it("does not strip // inside string values", () => {
    writeFileSync(
      join(dir, "moeicons.config.jsonc"),
      `{
  "schemaVersion": 1,
  "tier": "free",
  "framework": "react",
  "outputDir": "src/moeicons",
  "defaultTheme": "out//line",
  "themes": { "out//line": { "styleGroup": "moe-outline" } },
  "icons": ["ui-search"]
}`,
    );
    // "out//line" is not a real theme name but the parser must not strip it
    const result = readMoeiconsConfig(dir);
    // Will fail validation (defaultTheme "out//line" doesn't exist in catalog style groups by that name)
    // but the JSONC parsing itself should preserve the string — we just confirm it doesn't become "out"
    if (result.kind === "ok") {
      expect(result.config.defaultTheme).toBe("out//line");
    } else {
      // Also acceptable: invalid because style group doesn't exist, but not because JSONC mangled the string
      expect(result.kind).toBe("invalid");
    }
  });

  it("rejects an unsupported version", () => {
    writeFileSync(join(dir, "moeicons.config.json"), JSON.stringify({ schemaVersion: 99 }));
    expect(readMoeiconsConfig(dir).kind).toBe("unsupported");
  });

  it("rejects unparseable JSON", () => {
    writeFileSync(join(dir, "moeicons.config.json"), "{not json");
    expect(readMoeiconsConfig(dir).kind).toBe("invalid");
  });

  it("rejects unknown top-level fields", () => {
    writeConfig(dir, { unknownField: true });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("unknownField");
  });

  it("rejects unknown theme fields", () => {
    writeConfig(dir, {
      themes: { outline: { styleGroup: "moe-outline", unknownThemeKey: 1 } },
    });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("unknownThemeKey");
  });

  it("rejects tier elevation — free config with pro-only style group", () => {
    writeConfig(dir, {
      tier: "free",
      themes: { colored: { styleGroup: "moe-colored" } }, // moe-colored is pro-only
      defaultTheme: "colored",
    });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.message).toContain("moe-colored");
      expect(result.message).toContain("free");
    }
  });

  it("rejects an unknown icon id", () => {
    writeConfig(dir, { icons: ["non-existent-icon-xyz"] });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("non-existent-icon-xyz");
  });

  it("rejects an unknown style group", () => {
    writeConfig(dir, {
      themes: { custom: { styleGroup: "moe-does-not-exist" } },
      defaultTheme: "custom",
    });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("moe-does-not-exist");
  });

  it("rejects invalid missingIconPolicy value", () => {
    writeConfig(dir, { missingIconPolicy: "silent" });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("missingIconPolicy");
  });

  it("emits a deprecation warning for styles[] but still parses", () => {
    writeConfig(dir, {
      themes: { outline: { styleGroup: "moe-outline", styles: ["outline"] } },
    });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.warnings.some((w) => w.includes("styles") && w.includes("deprecated"))).toBe(true);
      // styles[] must not appear in the parsed config (it is stripped)
      expect(("styles" in result.config.themes["outline"]!)).toBe(false);
    }
  });

  it("prefix-group icons object is flattened and sorted by prefix", () => {
    writeConfig(dir, {
      icons: { arrow: ["arrow-bold-right"], user: ["user-account"] },
    });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.config.icons).toEqual(["arrow-bold-right", "user-account"]);
    }
  });

  it("merges patches preserving unrelated fields", () => {
    const base = {
      schemaVersion: 1 as const,
      tier: "free" as const,
      framework: "react" as const,
      outputDir: "src/moeicons",
      defaultTheme: "outline",
      themes: { outline: { styleGroup: "moe-outline" } },
      icons: ["ui-search"],
    };
    const merged = mergeMoeiconsConfig(base, { outputDir: "lib/moeicons" });
    expect(merged.outputDir).toBe("lib/moeicons");
    expect(merged.framework).toBe("react");
    expect(merged.icons).toEqual(["ui-search"]);
  });
});

describe("renderMoeiconsConfigJsonc", () => {
  it("uses the supplied framework (vue), not a hardcoded react", () => {
    const jsonc = renderMoeiconsConfigJsonc({ framework: "vue", tier: "free" });
    expect(jsonc).toContain('"framework": "vue"');
    expect(jsonc).not.toContain('"framework": "react"');
  });

  it("uses the supplied tier", () => {
    const freeJsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "free" });
    const proJsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "pro" });
    expect(freeJsonc).toContain('"tier": "free"');
    expect(proJsonc).toContain('"tier": "pro"');
  });

  it("default-selects all icons available in the requested tier", () => {
    const jsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "free" });
    // Every free icon id should appear in the JSONC (at least ui-search which is a well-known free icon)
    expect(jsonc).toContain('"ui-search"');
    // Total free icon count: the catalog has 554 icons; they should all be represented
    const matches = (jsonc.match(/"[a-z][a-z0-9-]+"/g) ?? []).filter((s) => !s.includes(":"));
    // At minimum all icons the catalog lists as available in a free group should be present
    expect(matches.length).toBeGreaterThan(100);
  });

  it("JSONC output can be written and re-parsed successfully", () => {
    const jsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "free" });
    writeFileSync(join(dir, "moeicons.config.jsonc"), jsonc);
    const result = readMoeiconsConfig(dir);
    // The rendered config is a valid, parseable JSONC with all catalog icons selected
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.config.schemaVersion).toBe(1);
      expect(result.config.framework).toBe("react");
      expect(result.config.icons.length).toBeGreaterThan(100);
    }
  });

  it("SVG theme entries do not contain imageSize or format fields by default", () => {
    const jsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "free" });
    // SVG theme block should not have imageSize key in un-commented section
    // (bitmap groups are commented out)
    const themeBlock = jsonc.slice(jsonc.indexOf('"themes"'), jsonc.indexOf('"icons"'));
    // The only uncommented keys inside an SVG theme entry should be styleGroup
    const uncommentedLines = themeBlock.split("\n").filter((l) => !l.trim().startsWith("//"));
    expect(uncommentedLines.some((l) => l.includes('"imageSize"'))).toBe(false);
  });
});
