import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planGeneratedFiles } from "../src/generator/generate.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";

/**
 * E2E-07: global theme-switch. Each proxy maps its own themes to variants and
 * resolves the current theme. A
 * missing icon follows the configured fallback policy.
 */

const config: MoeiconsConfigFile = {
  schemaVersion: 2,
  tier: "free",
  target: "react",
  outputDir: "src/moeicons",
  defaultTheme: "outline",
  themes: {
    outline: { styleGroup: "moe-outline", styles: ["outline"], className: "text-zinc-700" },
    solid: { styleGroup: "moe-solid", styles: ["fill"], className: "text-zinc-800" },
  },
  icons: ["arrow-bold-right", "user-account-circle"],
  missingIconPolicy: "fallback",
};

describe("E2E-07 theme-switch contract", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-theme-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates theme variants per icon without a global registry", () => {
    const plan = planGeneratedFiles(config, "src/moeicons");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.files.some((f) => f.path.endsWith("registry.ts"))).toBe(false);
    const proxy = plan.files.find((f) => f.path.endsWith("icons/ArrowBoldRight.tsx"))?.content ?? "";
    expect(proxy).toContain('"outline"');
    expect(proxy).toContain('"solid"');
    expect(proxy).not.toContain("UserAccountCircle");
  });

  it("proxy resolves theme from provider and falls back to defaultTheme", () => {
    const plan = planGeneratedFiles(config, "src/moeicons");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const proxy = plan.files.find((f) => f.path.endsWith("icons/ArrowBoldRight.tsx"))?.content ?? "";
    expect(proxy).toContain("useMoeiconsTheme");
    expect(proxy).toContain('import type { Theme } from "../types";');
    expect(proxy).toContain("switch (theme)");
    // User call sites must use logical theme keys, never style group ids.
    expect(proxy).toContain('case "outline":');
    expect(proxy).toContain('case "solid":');
    expect(proxy).not.toContain("ComponentType<any>");
  });

  it("proxy types and runtime passthrough keep className, size, and aria-label", () => {
    const plan = planGeneratedFiles(config, "src/moeicons");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const types = plan.files.find((f) => f.path.endsWith("types.ts"))?.content ?? "";
    const proxy = plan.files.find((f) => f.path.endsWith("icons/ArrowBoldRight.tsx"))?.content ?? "";
    expect(types).toContain("className?: string");
    expect(types).toContain("React.AriaAttributes");
    expect(proxy).toContain("...rest");
    expect(proxy).toContain("className={cn(");
  });

  it("illegal theme selection falls back to defaultTheme in generated provider usage", () => {
    const plan = planGeneratedFiles(config, "src/moeicons");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const provider = plan.files.find((f) => f.path.endsWith("provider.tsx"))?.content ?? "";
    expect(provider).toContain('useState<Theme>(props.defaultTheme ?? "outline")');
    expect(provider).toContain("const theme = props.theme ?? localTheme");
    const proxy = plan.files.find((f) => f.path.endsWith("icons/ArrowBoldRight.tsx"))?.content ?? "";
    // Unknown theme key → proxy variant miss → defaultTheme component.
    expect(proxy).toContain('default:\n      return <OutlineMoeOutlineArrowBoldRight');
  });

  it("missing icons follow the configured fallback policy", () => {
    expect(config.missingIconPolicy).toBe("fallback");
    // a partial selection still generates only requested icons
    const partial = { ...config, icons: ["arrow-bold-right"] };
    const plan = planGeneratedFiles(partial, "src/moeicons");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const paths = plan.files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("icons/ArrowBoldRight.tsx"))).toBe(true);
    expect(paths.some((p) => p.endsWith("icons/UserAccountCircle.tsx"))).toBe(false);
  });

  it("writes the generated tree deterministically", async () => {
    const plan = planGeneratedFiles(config, "src/moeicons");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    for (const file of plan.files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.content);
    }
    expect(existsSync(join(dir, "src", "moeicons", "registry.ts"))).toBe(false);
    expect(existsSync(join(dir, "src", "moeicons", "icons", "ArrowBoldRight.tsx"))).toBe(true);
    const proxy = readFileSync(join(dir, "src", "moeicons", "icons", "ArrowBoldRight.tsx"), "utf8");
    expect(proxy).toContain("Generated by moeicons CLI");
  });
});
