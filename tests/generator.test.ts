import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { planGeneratedFiles, toPascalCase } from "../src/generator/generate.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const config: MoeiconsConfigFile = {
  schemaVersion: 2,
  tier: "free",
  target: "react",
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

  it("assets target emits selected raw resources and manifest, never TypeScript", () => {
    const svg = new TextEncoder().encode('<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>');
    const result = planGeneratedFiles(
      { ...config, target: "assets", icons: ["arrow-bold-right"] },
      "src/moeicons",
      {
        archiveFiles: {
          "free/assets/manifest.json": new TextEncoder().encode(JSON.stringify({
            schemaVersion: 1,
            assets: [
              { path: "moe-outline/arrow-bold-right.svg", size: svg.byteLength, sha256: sha256(svg) },
              { path: "moe-solid/arrow-bold-right.svg", size: svg.byteLength, sha256: sha256(svg) },
            ],
          })),
          "free/assets/moe-outline/arrow-bold-right.svg": svg,
          "free/assets/moe-solid/arrow-bold-right.svg": svg,
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((file) => file.path)).toEqual([
        "src/moeicons/assets/moe-outline/arrow-bold-right.svg",
        "src/moeicons/assets/moe-solid/arrow-bold-right.svg",
        "src/moeicons/assets/manifest.json",
      ]);
    }
  });

  it("assets target rejects a manifest whose size/sha256 do not match the archive bytes", () => {
    const svg = new TextEncoder().encode('<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>');
    const wrongSha = sha256(new TextEncoder().encode("different bytes"));
    const wrongSize = new TextEncoder().encode('<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>extra');
    const tampered: Array<[string, Record<string, unknown>]> = [
      [
        "size mismatch",
        { size: svg.byteLength + 1, sha256: sha256(svg) },
      ],
      [
        "sha mismatch",
        { size: svg.byteLength, sha256: wrongSha },
      ],
      [
        "size and sha mismatch",
        { size: wrongSize.byteLength, sha256: wrongSha },
      ],
    ];
    for (const [label, entry] of tampered) {
      const result = planGeneratedFiles(
        { ...config, target: "assets", icons: ["arrow-bold-right"] },
        "src/moeicons",
        {
          archiveFiles: {
            "assets/manifest.json": new TextEncoder().encode(JSON.stringify({
              schemaVersion: 1,
              assets: [{ path: "moe-outline/arrow-bold-right.svg", ...entry }],
            })),
            "assets/moe-outline/arrow-bold-right.svg": svg,
          },
        },
      );
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((error) => error.includes("raw asset verification failed"))).toBe(true);
      }
    }
  });

  it("vanilla target emits dependency-free DOM factories from raw SVG", () => {
    const svg = new TextEncoder().encode('<svg viewBox="0 0 24 24"><g><path d="M1 1"/></g></svg>');
    const result = planGeneratedFiles(
      { ...config, target: "vanilla" },
      "src/moeicons",
      {
        archiveFiles: {
          "free/assets/manifest.json": new TextEncoder().encode(JSON.stringify({
            schemaVersion: 1,
            assets: [
              { path: "moe-outline/arrow-bold-right.svg", size: svg.byteLength, sha256: sha256(svg) },
              { path: "moe-solid/arrow-bold-right.svg", size: svg.byteLength, sha256: sha256(svg) },
              { path: "moe-outline/user-account-circle.svg", size: svg.byteLength, sha256: sha256(svg) },
              { path: "moe-solid/user-account-circle.svg", size: svg.byteLength, sha256: sha256(svg) },
            ],
          })),
          "free/assets/moe-outline/arrow-bold-right.svg": svg,
          "free/assets/moe-solid/arrow-bold-right.svg": svg,
          "free/assets/moe-outline/user-account-circle.svg": svg,
          "free/assets/moe-solid/user-account-circle.svg": svg,
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const factory = result.files.find((file) => file.path.endsWith("moe-outline/ArrowBoldRight.ts"))?.content;
      expect(factory).toContain("createElementNS");
      expect(factory).toContain("createArrowBoldRight");
      expect(factory).not.toContain("export const ArrowBoldRight =");
    }
  });
});
