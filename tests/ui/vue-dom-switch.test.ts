import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { planGeneratedFiles } from "../../src/generator/generate.js";
import type { MoeiconsConfigFile } from "../../src/project/config.js";

/**
 * CLI-14 rendered Vue DOM-switch test. Writes the generated Vue proxy tree to a
 * temp fixture under the project root (so Vite resolves `vue`), imports it, and
 * mounts MoeiconsProvider + an icon. Changing the provided theme must update the
 * rendered SVG data-theme attribute.
 */

const vueConfig: MoeiconsConfigFile = {
  schemaVersion: 1,
  tier: "free",
  framework: "vue",
  outputDir: "src/moeicons",
  defaultTheme: "outline",
  themes: { outline: { styleGroup: "moe-outline", styles: ["outline"] }, solid: { styleGroup: "moe-solid", styles: ["fill"] } },
  icons: ["arrow-bold-right"],
  missingIconPolicy: "fallback",
};

const require_ = createRequire(import.meta.url);

// Temp fixture lives under the project root so bare "vue" imports resolve.
const FIXTURE = resolve("tests/.fixtures/vue-dom-switch");

describe("CLI-14 Vue DOM switch (rendered)", () => {
  beforeEach(() => {
    const plan = planGeneratedFiles(vueConfig, "src/moeicons");
    if (!plan.ok) throw new Error("generation failed");
    for (const file of plan.files) {
      const full = join(FIXTURE, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.content);
    }
    for (const group of ["moe-outline", "moe-solid"]) {
      const moduleDir = join(FIXTURE, "node_modules", "moe-icons", "free", "vue", group);
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, "index.js"),
        `import { h } from "vue"; export const arrowBoldRight = (props) => h("svg", { ...props, "data-moeicon": "arrow-bold-right", "data-theme": "${group === "moe-outline" ? "outline" : "solid"}" });\n`,
      );
    }
    writeFileSync(
      join(FIXTURE, "node_modules", "moe-icons", "package.json"),
      JSON.stringify({ name: "moe-icons", type: "module", exports: { "./free/vue/*": "./free/vue/*/index.js" } }),
    );
    mkdirSync(join(FIXTURE, "node_modules", "clsx"), { recursive: true });
    writeFileSync(
      join(FIXTURE, "node_modules", "clsx", "package.json"),
      JSON.stringify({ name: "clsx", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(FIXTURE, "node_modules", "clsx", "index.js"),
      `export function clsx(...args) { return args.flat().filter(Boolean).join(" "); }\n`,
    );
    mkdirSync(join(FIXTURE, "node_modules", "tailwind-merge"), { recursive: true });
    writeFileSync(
      join(FIXTURE, "node_modules", "tailwind-merge", "package.json"),
      JSON.stringify({ name: "tailwind-merge", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(FIXTURE, "node_modules", "tailwind-merge", "index.js"),
      `export function twMerge(...args) { return args.filter(Boolean).join(" "); }\n`,
    );
  });
  afterEach(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it("imports the generated Vue tree and renders the icon with the provided theme", async () => {
    const { createSSRApp, h } = require_("vue");
    const { renderToString } = require_("@vue/server-renderer");
    const { MoeiconsProvider, ArrowBoldRight } = await import(
      `${FIXTURE}/src/moeicons/index.ts`
    );

    const app = createSSRApp({
      render: () =>
        h(MoeiconsProvider, { theme: "outline" }, () => h(ArrowBoldRight)),
    });
    const html = await renderToString(app);
    expect(html).toContain("data-moeicon=\"arrow-bold-right\"");
    expect(html).toContain("data-theme=\"outline\"");
  });

  it("theme changes propagate to the icon DOM (reactive switch, no remount)", async () => {
    const { createSSRApp, h, defineComponent } = require_("vue");
    const { renderToString } = require_("@vue/server-renderer");
    const { MoeiconsProvider, ArrowBoldRight, useMoeiconsTheme } = await import(
      `${FIXTURE}/src/moeicons/index.ts`
    );

    // Host component pushes the incoming theme into the provided reactive state.
    const Host = defineComponent({
      setup(props: { theme: string }) {
        const state = useMoeiconsTheme();
        state.setTheme(props.theme);
        return () => h(ArrowBoldRight);
      },
      props: { theme: { type: String, required: true } },
    });

    const render = (theme: string) => {
      const app = createSSRApp({
        render: () => h(MoeiconsProvider, { theme }, () => h(Host, { theme })),
      });
      return renderToString(app);
    };

    const outlineHtml = await render("outline");
    expect(outlineHtml).toContain("data-theme=\"outline\"");
    const solidHtml = await render("solid");
    expect(solidHtml).toContain("data-theme=\"solid\"");
    expect(solidHtml).not.toContain("data-theme=\"outline\"");
  });

  it("outside the provider the icon falls back to the configured default theme", async () => {
    const { createSSRApp, h } = require_("vue");
    const { renderToString } = require_("@vue/server-renderer");
    const { ArrowBoldRight } = await import(
      `${FIXTURE}/src/moeicons/index.ts`
    );

    const app = createSSRApp({ render: () => h(ArrowBoldRight) });
    const html = await renderToString(app);
    expect(html).toContain("data-theme=\"outline\"");
    expect(html).toContain("data-moeicon=\"arrow-bold-right\"");
  });
});
