import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectTailwind,
  ensureClassMergeDependencies,
  injectContentGlob,
  planTailwindIntegration,
} from "../src/project/tailwind.js";
import { CliError } from "../src/errors/index.js";

describe("Tailwind content inject (H3/H4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tw-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("idempotently injects a static content glob", () => {
    const source = `module.exports = {\n  content: [\n    "./index.html",\n  ],\n};\n`;
    const first = injectContentGlob(source, "./src/moeicons/**/*.{js,ts,jsx,tsx,vue}");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.changed).toBe(true);
    expect(first.nextSource).toContain("./src/moeicons/**/*.{js,ts,jsx,tsx,vue}");
    const second = injectContentGlob(first.nextSource, "./src/moeicons/**/*.{js,ts,jsx,tsx,vue}");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(false);
  });

  it("refuses non-static content shapes with a precise hint", () => {
    const source = `module.exports = { content: ["./index.html", ...extra] };\n`;
    const result = injectContentGlob(source, "./src/moeicons/**/*.tsx");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain("manually");
  });

  it("detects Tailwind v4 and throws TAILWIND_VERSION_UNSUPPORTED unless --no-tailwind", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { tailwindcss: "^4.0.0" } }),
    );
    writeFileSync(join(dir, "tailwind.config.js"), "export default { content: [] }\n");
    expect(detectTailwind(dir).kind).toBe("v4");
    expect(() => planTailwindIntegration(dir, "src/moeicons", { noTailwind: false })).toThrow(CliError);
    try {
      planTailwindIntegration(dir, "src/moeicons", { noTailwind: false });
    } catch (error) {
      expect(error).toMatchObject({ code: "TAILWIND_VERSION_UNSUPPORTED" });
    }
    const skipped = planTailwindIntegration(dir, "src/moeicons", { noTailwind: true });
    expect(skipped.files).toEqual([]);
    expect(skipped.notes[0]).toContain("--no-tailwind");
  });

  it("detects config-less Tailwind v4 Vite projects from package.json", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { tailwindcss: "4.1.12", "@tailwindcss/vite": "4.1.12" } }),
    );
    expect(detectTailwind(dir)).toMatchObject({ kind: "v4", configPath: join(dir, "package.json") });
    expect(() => planTailwindIntegration(dir, "src/moeicons", { noTailwind: false })).toThrow("only auto-integrates Tailwind v3");
  });

  it("updates a v3 config on disk plan", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { tailwindcss: "^3.4.0" } }),
    );
    const configPath = join(dir, "tailwind.config.js");
    writeFileSync(configPath, `module.exports = {\n  content: [\"./index.html\"],\n};\n`);
    const plan = planTailwindIntegration(dir, "src/moeicons", { noTailwind: false });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.content).toContain("./src/moeicons/**/*.{js,ts,jsx,tsx,vue}");
  });

  it("adds locked clsx and tailwind-merge ranges without using latest", () => {
    const result = ensureClassMergeDependencies(JSON.stringify({ name: "x", version: "1.0.0" }, null, 2));
    expect(result.changed).toBe(true);
    const pkg = JSON.parse(result.nextSource) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.clsx).toBe("^2.1.1");
    expect(pkg.dependencies["tailwind-merge"]).toBe("^2.5.2");
    expect(Object.values(pkg.dependencies).every((range) => range !== "latest")).toBe(true);
  });

  it("preserves CRLF and untouched package fields during minimal dependency edits", () => {
    const source = '{\r\n\t"name": "x",\r\n\t"custom": { "keep": true }\r\n}\r\n';
    const result = ensureClassMergeDependencies(source);
    expect(result.nextSource).not.toMatch(/(^|[^\r])\n/);
    expect(result.nextSource).toContain('\t"custom": { "keep": true }');
    expect(JSON.parse(result.nextSource)).toMatchObject({ custom: { keep: true }, dependencies: { clsx: "^2.1.1", "tailwind-merge": "^2.5.2" } });
  });
});
