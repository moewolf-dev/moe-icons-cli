// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { planGeneratedFiles } from "../../src/generator/generate.js";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function generatedProvider() {
  const parent = resolve("tests/.fixtures");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "vue-mounted-"));
  fixtures.push(root);
  const outcome = planGeneratedFiles({ schemaVersion: 3, tier: "free", target: "vue", outputDir: "src/moeicons", defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" }, solid: { styleGroup: "moe-solid" } }, icons: ["ui-search"], missingIconPolicy: "error" }, "src/moeicons");
  if (!outcome.ok) throw new Error(outcome.errors.join("; "));
  for (const file of outcome.files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  const provider = await import(`${root}/src/moeicons/provider.ts`);
  const composable = await import(`${root}/src/moeicons/composable.ts`);
  return { ...provider, ...composable };
}

describe("fresh Vue Provider mounted contract", () => {
  it("updates one mounted consumer when controlled props change and emits internal requests", async () => {
    const { MoeiconsProvider, useMoeiconsTheme } = await generatedProvider();
    let setups = 0;
    const Consumer = defineComponent({ setup() {
      setups++;
      const state = useMoeiconsTheme();
      return () => h("button", { onClick: () => state.setTheme("solid") }, state.theme.value);
    } });
    const app = mount(MoeiconsProvider, { props: { theme: "outline" }, slots: { default: () => h(Consumer) } });
    try {
      const node = app.find("button").element;
      await app.find("button").trigger("click");
      expect(app.text()).toBe("outline");
      expect(app.emitted("update:theme")).toEqual([["solid"]]);
      await app.setProps({ theme: "solid" });
      expect(app.text()).toBe("solid");
      expect(app.find("button").element).toBe(node);
      expect(setups).toBe(1);
    } finally { app.unmount(); }
  });

  it("switches uncontrolled state and uses the default outside a Provider", async () => {
    const { MoeiconsProvider, useMoeiconsTheme } = await generatedProvider();
    const Consumer = defineComponent({ setup() {
      const state = useMoeiconsTheme();
      return () => h("button", { onClick: () => state.setTheme("solid") }, state.theme.value);
    } });
    const app = mount(MoeiconsProvider, { slots: { default: () => h(Consumer) } });
    const standalone = mount(Consumer);
    try {
      await app.find("button").trigger("click");
      await nextTick();
      expect(app.text()).toBe("solid");
      await standalone.find("button").trigger("click");
      expect(standalone.text()).toBe("outline");
    } finally { app.unmount(); standalone.unmount(); }
  });
});
