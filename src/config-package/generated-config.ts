import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface GeneratedRenderOptions {
  target?: "react" | "vue" | "vanilla" | "assets";
  framework?: "react" | "vue";
  tier?: "free" | "pro";
  catalog: unknown;
  integration?: { adapter: string; entry?: string; style?: string };
}

export interface GeneratedConfigPackage {
  renderMoeiconsConfigJsonc(options: GeneratedRenderOptions): string;
  validateConfig(raw: unknown, catalog: unknown): {
    ok: boolean;
    kind?: string;
    message?: string;
    version?: number;
    warnings?: string[];
    config?: unknown;
  };
  VERSION: number;
}

/**
 * Load the code-library canonical config-package modules that were synced into
 * `src/config-package/generated/`. The generated copy is committed with
 * SOURCE.json (code-library commit + file digests) and copied to dist at build
 * time so both tests (src) and the packaged CLI (dist) resolve the same
 * relative path.
 */
export function loadGeneratedConfigPackage(): GeneratedConfigPackage {
  const root = dirname(fileURLToPath(import.meta.url));
  const renderPath = join(root, "..", "config-package", "generated", "render-config.cjs");
  const validatePath = join(root, "..", "config-package", "generated", "validate-config.cjs");
  const renderer = require(renderPath) as Pick<GeneratedConfigPackage, "renderMoeiconsConfigJsonc">;
  const validator = require(validatePath) as Pick<
    GeneratedConfigPackage,
    "validateConfig" | "VERSION"
  >;
  return { ...renderer, ...validator };
}
