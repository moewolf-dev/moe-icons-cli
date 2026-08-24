import { describe, it, expect } from "vitest";
import { planGeneratedFiles, toPascalCase } from "../src/generator/generate.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";

const config: MoeiconsConfigFile = {
  schemaVersion: 1,
  tier: "free",
  framework: "react",
  outputDir: "src/moeicons",
  defaultTheme: "outline",
  themes: { outline: { styleGroup: "moe-outline" }, solid: { styleGroup: "moe-solid" } },
  icons: ["arrow-bold-right", "user-account-circle"],
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
      expect(paths).toContain("src/moeicons/icons/ArrowBoldRight.tsx");
      expect(paths).toContain("src/moeicons/icons/UserAccountCircle.tsx");
      expect(paths).toContain("src/moeicons/index.ts");
      const registry = result.files.find((f) => f.path.endsWith("registry.ts"))?.content;
      expect(registry).toContain("ArrowBoldRight");
      expect(registry).toContain("UserAccountCircle");
      expect(registry).toContain(
        'import { arrowBoldRight as OutlineMoeOutlineArrowBoldRight } from "moe-icons/free/react/moe-outline";',
      );
      expect(paths).toContain("src/moeicons/cn.ts");
      const proxy = result.files.find((f) => f.path.endsWith("icons/ArrowBoldRight.tsx"))?.content;
      expect(proxy).toContain('cn("moe-icon"');
    }
  });

  it("rejects icons that are not available in every configured theme", () => {
    const unavailable: MoeiconsConfigFile = {
      ...config,
      icons: ["arrow-chevron-right"],
    };
    const result = planGeneratedFiles(unavailable, "src/moeicons");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes('icon "arrow-chevron-right"'))).toBe(true);
      expect(result.errors.some((error) => error.includes('style group "moe-outline"'))).toBe(true);
    }
  });

  it("rejects colliding proxy names that only meet after reserved-word prefixing", () => {
    const dup: MoeiconsConfigFile = {
      ...config,
      icons: ["class", "icon-class"],
    };
    const result = planGeneratedFiles(dup, "src/moeicons");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("duplicate PascalCase"))).toBe(true);
      expect(result.errors.some((error) => error.includes("duplicate library export"))).toBe(true);
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
