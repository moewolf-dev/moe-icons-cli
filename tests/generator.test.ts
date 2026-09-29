import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { planGeneratedFiles, toPascalCase } from "../src/generator/generate.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";
import { catalog } from "../src/catalog/catalog.js";

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
  it("generates types, per-icon proxies, and barrel without a global registry", () => {
    const result = planGeneratedFiles(config, "src/moeicons");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.files.map((f) => f.path);
      expect(paths).toContain("src/moeicons/types.ts");
      expect(paths).not.toContain("src/moeicons/registry.ts");
      expect(paths).toContain("src/moeicons/icons/ArrowBoldRight.tsx");
      expect(paths).toContain("src/moeicons/icons/UserAccountCircle.tsx");
      expect(paths).toContain("src/moeicons/index.ts");
      const proxy = result.files.find((f) => f.path.endsWith("icons/ArrowBoldRight.tsx"))?.content;
      expect(proxy).toContain("ArrowBoldRight");
      expect(proxy).not.toContain("UserAccountCircle");
      expect(proxy).toContain(
        'import OutlineMoeOutlineArrowBoldRight from "../../../.moeicons/artifact/react/moe-outline/ArrowBoldRight.js";',
      );
      expect(paths).toContain("src/moeicons/cn.ts");
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

  it("binds a missing nondefault theme to the available default icon", () => {
    const partialCatalog = { ...catalog, icons: catalog.icons.map((icon) =>
      icon.id === "arrow-bold-right"
        ? { ...icon, availableIn: icon.availableIn.filter((group) => group !== "moe-solid") }
        : icon) };
    const partialConfig = { ...config, icons: ["arrow-bold-right"] };
    const fallback = planGeneratedFiles(partialConfig, "src/moeicons", { catalog: partialCatalog });
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      const proxy = String(fallback.files.find((file) => file.path.endsWith("icons/ArrowBoldRight.tsx"))?.content);
      expect(proxy).toContain('import SolidMoeOutlineArrowBoldRight from "../../../.moeicons/artifact/react/moe-outline/ArrowBoldRight.js"');
      expect(proxy).not.toContain("react/moe-solid/ArrowBoldRight.js");
    }
    const strict = planGeneratedFiles({ ...partialConfig, missingIconPolicy: "error" }, "src/moeicons", { catalog: partialCatalog });
    expect(strict.ok).toBe(false);
  });

  it("applies theme default size and stroke width in the icon proxy", () => {
    const changed = { ...config, themes: {
      outline: { styleGroup: "moe-outline", defaultSize: 37, strokeWidth: 5 },
      solid: { styleGroup: "moe-solid", defaultSize: 24 },
    } };
    const result = planGeneratedFiles(changed, "src/moeicons");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const proxy = String(result.files.find((file) => file.path.endsWith("icons/ArrowBoldRight.tsx"))?.content);
      expect(proxy).toContain('"outline": 37');
      expect(proxy).toContain('"outline": 5');
      expect(proxy).toContain("width={resolvedSize} height={resolvedSize}");
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
