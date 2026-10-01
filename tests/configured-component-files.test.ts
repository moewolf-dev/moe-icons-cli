import { describe, expect, it } from "vitest";
import { configuredComponentFiles } from "../src/core/target-subtree.js";
import { catalog } from "../src/catalog/catalog.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";

const bytes = (value: string): Uint8Array => Buffer.from(value);
const config: MoeiconsConfigFile = {
  schemaVersion: 3, tier: "free", target: "vue", outputDir: "src/moeicons",
  defaultTheme: "outline", themes: { outline: { styleGroup: "moe-outline" } },
  icons: ["ui-search"],
};

describe("configured component installation", () => {
  it("retains only selected icon modules and their transitive Vue dependencies", () => {
    const files = {
      "types.d.ts": bytes("export interface VueIconProps {}"),
      "index.js": bytes("export * from './moe-outline/index.js';"),
      "moe-outline/index.js": bytes("export { default as UiSearch } from './UiSearch.vue.js'; export { default as Archive } from './Archive.vue.js';"),
      "moe-outline/UiSearch.vue.js": bytes("import icon from './UiSearch.vue2.js'; import helper from './_virtual/helper.js'; export default icon;"),
      "moe-outline/UiSearch.vue2.js": bytes("export default {};"),
      "moe-outline/UiSearch.vue.d.ts": bytes("import type { VueIconProps } from '../types'; export default VueIconProps;"),
      "moe-outline/_virtual/helper.js": bytes("export default {};"),
      "moe-outline/Archive.vue.js": bytes("export default {};"),
    };
    const selected = configuredComponentFiles(files, "vue", config, catalog);
    expect(Object.keys(selected).sort()).toEqual([
      "moe-outline/UiSearch.vue.d.ts", "moe-outline/UiSearch.vue.js",
      "moe-outline/UiSearch.vue2.js", "moe-outline/_virtual/helper.js", "types.d.ts",
    ].sort());
  });

  it("fails before writing when a configured module is absent", () => {
    expect(() => configuredComponentFiles({ "types.d.ts": bytes("") }, "vue", config, catalog))
      .toThrow(/missing configured module.*UiSearch/);
  });
});
