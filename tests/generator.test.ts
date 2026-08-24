import { describe, it, expect } from "vitest";
import { planGeneratedFiles, toPascalCase } from "../src/generator/generate.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";

const config: MoeiconsConfigFile = {
  schemaVersion: 1,
  tier: "free",
  framework: "react",
  outputDir: "src/moeicons",
  defaultTheme: "outline",
  themes: { outline: { styleGroup: "moe-outline", styles: ["outline"] }, solid: { styleGroup: "moe-solid", styles: ["fill"] } },
  icons: ["arrow-chevron-right", "user-circle"],
  missingIconPolicy: "fallback",
};

describe("toPascalCase", () => {
  it("converts kebab to Pascal deterministically", () => {
    expect(toPascalCase("arrow-chevron-right")).toBe("ArrowChevronRight");
  });
});

describe("planGeneratedFiles", () => {
  it("generates types, registry, proxies, and barrel", () => {
    const result = planGeneratedFiles(config, "src/moeicons");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.files.map((f) => f.path);
      expect(paths).toContain("src/moeicons/types.ts");
      expect(paths).toContain("src/moeicons/registry.ts");
      expect(paths).toContain("src/moeicons/icons/ArrowChevronRight.tsx");
      expect(paths).toContain("src/moeicons/icons/UserCircle.tsx");
      expect(paths).toContain("src/moeicons/index.ts");
      const registry = result.files.find((f) => f.path.endsWith("registry.ts"))?.content;
      expect(registry).toContain("ArrowChevronRight");
      expect(registry).toContain("UserCircle");
    }
  });

  it("rejects duplicate PascalCase names", () => {
    const dup: MoeiconsConfigFile = {
      ...config,
      icons: ["ab-c", "ab-c"],
    };
    const result = planGeneratedFiles(dup, "src/moeicons");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.includes("duplicate PascalCase")).toBe(true);
  });

  it("rejects a config with no themes", () => {
    const bad: MoeiconsConfigFile = { ...config, themes: {} };
    const result = planGeneratedFiles(bad, "src/moeicons");
    expect(result.ok).toBe(false);
  });
});
