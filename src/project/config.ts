import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * moeicons.config.ts v1 loading/merging. Distinguishes absent/invalid/
 * unsupported-version. Never executes arbitrary remote config; uses a safe
 * data-only load for the config file.
 */

export interface MoeiconsConfigFile {
  readonly schemaVersion: number;
  readonly framework: "react" | "vue";
  readonly outputDir: string;
  readonly defaultTheme: string;
  readonly themes: Readonly<Record<string, { styles: string[]; defaultSize?: number; strokeWidth?: number; className?: string }>>;
  readonly icons: readonly string[];
  readonly missingIconPolicy?: "fallback" | "error";
}

export type ConfigLoadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unsupported"; readonly version: number }
  | { readonly kind: "ok"; readonly config: MoeiconsConfigFile };

const SUPPORTED_FILENAMES = ["moeicons.config.ts", "moeicons.config.js", "moeicons.config.json"];

export function findConfigFile(root: string): string | undefined {
  for (const name of SUPPORTED_FILENAMES) {
    if (existsSync(join(root, name))) return join(root, name);
  }
  return undefined;
}

/** Load a JSON-based config (`.json`), distinguishing missing/invalid/unsupported. */
export function readMoeiconsConfig(root: string): ConfigLoadResult {
  const jsonPath = findConfigFile(root);
  if (!jsonPath || !jsonPath.endsWith(".json")) {
    // TS/JS configs are transpiled by the CLI's build; the runtime loader uses JSON.
    if (jsonPath) {
      return {
        kind: "invalid",
        message: "TS/JS config requires transpilation; use moeicons.config.json for the runtime loader",
      };
    }
    return { kind: "missing" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    return { kind: "invalid", message: `cannot parse ${jsonPath}` };
  }
  if (typeof raw !== "object" || raw === null) {
    return { kind: "invalid", message: "config must be an object" };
  }
  const config = raw as Record<string, unknown>;
  if (typeof config.schemaVersion !== "number") {
    return { kind: "invalid", message: "schemaVersion required" };
  }
  if (config.schemaVersion !== 1) {
    return { kind: "unsupported", version: config.schemaVersion };
  }
  if (config.framework !== "react" && config.framework !== "vue") {
    return { kind: "invalid", message: "framework must be react or vue" };
  }
  return { kind: "ok", config: config as unknown as MoeiconsConfigFile };
}

/** Merge a patch into the current config, preserving unrelated fields. */
export function mergeMoeiconsConfig(
  current: MoeiconsConfigFile,
  patch: Partial<MoeiconsConfigFile>,
): MoeiconsConfigFile {
  return {
    schemaVersion: 1,
    framework: patch.framework ?? current.framework,
    outputDir: patch.outputDir ?? current.outputDir,
    defaultTheme: patch.defaultTheme ?? current.defaultTheme,
    themes: patch.themes ?? current.themes,
    icons: patch.icons ?? current.icons,
    ...(patch.missingIconPolicy !== undefined
      ? { missingIconPolicy: patch.missingIconPolicy }
      : current.missingIconPolicy !== undefined
        ? { missingIconPolicy: current.missingIconPolicy }
        : {}),
  };
}
