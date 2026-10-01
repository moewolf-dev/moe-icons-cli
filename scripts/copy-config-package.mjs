import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySvgModel } from "./verify-svg-model.mjs";

// Copy the canonical config-package generated modules into dist so the packaged
// CLI can resolve them offline (same relative layout as src).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "src", "config-package", "generated");
const targetDir = join(root, "dist", "config-package", "generated");
mkdirSync(targetDir, { recursive: true });
for (const name of readdirSync(sourceDir)) {
  cpSync(join(sourceDir, name), join(targetDir, name));
}
console.log(`copied config-package generated modules to dist/config-package/generated`);
// The packaged CLI must carry the canonical SVG parser for offline raw fallback.
const svgSource = join(root, "src/generator/shared");
verifySvgModel({ root });
const svgTarget = join(root, "dist/generator/shared");
mkdirSync(svgTarget, { recursive: true });
for (const name of readdirSync(svgSource)) cpSync(join(svgSource, name), join(svgTarget, name));
