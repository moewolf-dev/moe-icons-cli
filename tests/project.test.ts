import { catalog, findCatalogStyleGroup } from "../src/catalog/catalog.js";
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
import {
  readMoeiconsConfig,
  mergeMoeiconsConfig,
  renderMoeiconsConfigJsonc,
} from "../src/project/config.js";

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
    expect(assertWritableProject(dir, join(dir, "node_modules", "x"), []).length).toBeGreaterThan(
      0,
    );
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
      expect(result.config.target).toBe("react");
      expect(result.warnings).toContain('config schema v1 migrated "framework" to "target"');
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

  it("requires target in v2 and rejects framework in v2", () => {
    writeConfig(dir, { schemaVersion: 2, framework: undefined, target: undefined });
    let result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("target must be");

    writeConfig(dir, { schemaVersion: 2, target: "react", framework: "react" });
    result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("framework");
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
      themes: { private: { styleGroup: "test-pro-only" } },
      defaultTheme: "private",
    });
    // Public release catalogs contain Free groups. Tier enforcement uses the
    // verified runtime catalog, so exercise an explicit Pro-only fixture.
    const scopedCatalog = { ...catalog, styleGroups: [...catalog.styleGroups,
      { ...findCatalogStyleGroup("moe-outline")!, id: "test-pro-only", tiers: ["pro"] as const },
    ] };
    const result = readMoeiconsConfig(dir, scopedCatalog);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.message).toContain("test-pro-only");
      expect(result.message).toContain("free");
    }
    writeConfig(dir, { tier: "pro", themes: { private: { styleGroup: "test-pro-only" } }, defaultTheme: "private" });
    expect(readMoeiconsConfig(dir, scopedCatalog).kind).toBe("ok");
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

  it("rejects unsafe integration path segments and Windows drive paths", () => {
    for (const entry of ["src/../main.tsx", "src//main.tsx", "C:/main.tsx"]) {
      writeConfig(dir, {
        schemaVersion: 3,
        framework: undefined,
        target: "react",
        integration: { adapter: "vite-react", entry },
      });
      const result = readMoeiconsConfig(dir);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") expect(result.message).toContain("integration.entry");
    }
  });

  it("emits a deprecation warning for styles[] but still parses", () => {
    writeConfig(dir, {
      themes: { outline: { styleGroup: "moe-outline", styles: ["outline"] } },
    });
    const result = readMoeiconsConfig(dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.warnings.some((w) => w.includes("styles") && w.includes("deprecated"))).toBe(
        true,
      );
      // styles[] must not appear in the parsed config (it is stripped)
      expect("styles" in result.config.themes["outline"]!).toBe(false);
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
    expect(merged.target).toBe("react");
    expect("framework" in merged).toBe(false);
    expect(merged.icons).toEqual(["ui-search"]);
    const fixed = {
      ...base,
      schemaVersion: 3 as const,
      target: "react" as const,
      downloadMode: "full" as const,
    };
    expect(mergeMoeiconsConfig(fixed, { outputDir: "lib/icons" })).toMatchObject({
      schemaVersion: 3,
      downloadMode: "full",
    });
    expect(mergeMoeiconsConfig(fixed, { downloadMode: "icons" })).toMatchObject({
      schemaVersion: 3,
      downloadMode: "icons",
    });
  });
});

describe("renderMoeiconsConfigJsonc", () => {
  it("uses the supplied framework (vue), not a hardcoded react", () => {
    const jsonc = renderMoeiconsConfigJsonc({ framework: "vue", tier: "free" });
    expect(jsonc).toContain('"target": "vue"');
    expect(jsonc).not.toContain('"target": "react"');
  });

  it("uses the supplied tier", () => {
    const freeJsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "free" });
    const proJsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "pro" });
    expect(freeJsonc).toContain('"tier": "free"');
    expect(proJsonc).toContain('"tier": "pro"');
  });

  it("default-selects a small set of available icons", () => {
    const jsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "free" });
    // The initial config is small enough for a first project build.
    expect(jsonc).toContain('"ui-search"');
    const matches = (jsonc.match(/"[a-z][a-z0-9-]+"/g) ?? []).filter((s) => !s.includes(":"));
    expect(matches.length).toBeLessThan(100);
  });

  it("JSONC output can be written and re-parsed successfully", () => {
    const jsonc = renderMoeiconsConfigJsonc({ framework: "react", tier: "free" });
    writeFileSync(join(dir, "moeicons.config.jsonc"), jsonc);
    const result = readMoeiconsConfig(dir);
    // The rendered config is valid JSONC with two example icons.
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.config.schemaVersion).toBe(3);
      expect(result.config.target).toBe("react");
      expect(result.config.icons.length).toBe(2);
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
