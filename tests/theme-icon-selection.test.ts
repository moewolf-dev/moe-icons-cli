import { describe, expect, it } from "vitest";
import { catalog } from "../src/catalog/catalog.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";
import { resolveIconTheme } from "../src/core/icon-selection.js";
import { configuredComponentFiles } from "../src/core/target-subtree.js";
import { planGeneratedFiles } from "../src/generator/generate.js";
import { createHash } from "node:crypto";

const config: MoeiconsConfigFile = {
  schemaVersion: 3, tier: "free", target: "react", outputDir: "src/moeicons",
  defaultTheme: "outline", icons: ["ui-search", "arrow-bold-right"], missingIconPolicy: "fallback",
  themes: {
    outline: { styleGroup: "moe-outline", icons: ["ui-search", "arrow-bold-right"] },
    solid: { styleGroup: "moe-solid", icons: ["arrow-bold-right"] },
  },
};

describe("per-theme icon selection", () => {
  it("resolves missing selection to default without admitting unregistered icons", () => {
    expect(resolveIconTheme(config, catalog, "solid", "ui-search")).toBe("outline");
    expect(resolveIconTheme(config, catalog, "solid", "archive")).toBeUndefined();
    expect(resolveIconTheme({ ...config, missingIconPolicy: "error" }, catalog, "solid", "ui-search")).toBeUndefined();
  });

  it("falls back from an empty default theme with stable ordering independent of JSON order", () => {
    const themes = {
      zeta: { styleGroup: "moe-solid", icons: ["ui-search"] },
      outline: { styleGroup: "moe-outline", icons: [] },
      alpha: { styleGroup: "moe-outline", icons: ["ui-search"] },
    };
    const selected = { ...config, icons: ["ui-search"], themes };
    expect(resolveIconTheme(selected, catalog, "outline", "ui-search")).toBe("alpha");
    expect(resolveIconTheme({ ...selected, themes: Object.fromEntries(Object.entries(themes).reverse()) }, catalog, "outline", "ui-search")).toBe("alpha");
  });

  it("React and Vue proxies reference only selected variants", () => {
    for (const target of ["react", "vue"] as const) {
      const generated = planGeneratedFiles({ ...config, target }, config.outputDir);
      expect(generated.ok).toBe(true);
      if (!generated.ok) continue;
      const search = String(generated.files.find((file) => /icons\/UiSearch\./.test(file.path))?.content);
      expect(search).toContain(`${target}/moe-outline/UiSearch`);
      expect(search).not.toContain(`${target}/moe-solid/UiSearch`);
      const all = Object.fromEntries(["moe-outline/UiSearch", "moe-outline/ArrowBoldRight", "moe-solid/ArrowBoldRight"].flatMap((module) => {
        const name = module + (target === "vue" ? ".vue" : "");
        return [[`${name}.js`, Buffer.from("export default {};")], [`${name}.d.ts`, Buffer.from("export default {};")]];
      }));
      const installed = configuredComponentFiles({ ...all, "types.d.ts": Buffer.from("") }, target, { ...config, target }, catalog);
      expect(Object.keys(installed)).toHaveLength(7);
      expect(Object.keys(installed).some((path) => path.includes("moe-solid/UiSearch"))).toBe(false);
    }
  });

  it("raw assets and Vanilla factories retain only selected group/icon pairs", () => {
    const archiveFiles = Object.fromEntries(["moe-outline/ui-search", "moe-outline/arrow-bold-right", "moe-solid/arrow-bold-right"].map((name) =>
      [`assets/${name}.svg`, Buffer.from('<svg viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>')]));
    archiveFiles["assets/manifest.json"] = Buffer.from(JSON.stringify({ schemaVersion: 1, assets: Object.entries(archiveFiles).map(([path, bytes]) => ({ path: path.replace(/^assets\//, ""), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })) }));
    for (const target of ["assets", "vanilla"] as const) {
      const generated = planGeneratedFiles({ ...config, target }, config.outputDir, { archiveFiles });
      expect(generated.ok).toBe(true);
      if (!generated.ok) continue;
      expect(generated.files.some((file) => file.path.includes("moe-solid/UiSearch") || file.path.includes("moe-solid/ui-search"))).toBe(false);
    }
  });

  it("fails when every configured theme omits an icon and when error requires a missing variant", () => {
    for (const bad of [
      { ...config, themes: { outline: { styleGroup: "moe-outline", icons: [] } } },
      { ...config, missingIconPolicy: "error" as const },
    ]) expect(planGeneratedFiles(bad, config.outputDir).ok).toBe(false);
  });
});
