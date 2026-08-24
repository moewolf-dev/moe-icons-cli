import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { catalog, findCatalogIcon, findCatalogStyleGroup } from "../catalog/catalog.js";

export interface MoeiconsThemeConfig {
  readonly styleGroup: string;
  readonly styles?: readonly string[];
  readonly format?: "svg" | "webp" | "png";
  readonly imageSize?: 64 | 128 | 256 | 512;
  readonly defaultSize?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
}

export interface MoeiconsConfigFile {
  readonly schemaVersion: 1;
  readonly tier: "free" | "pro";
  readonly framework: "react" | "vue";
  readonly outputDir: string;
  readonly defaultTheme: string;
  readonly themes: Readonly<Record<string, MoeiconsThemeConfig>>;
  readonly icons: readonly string[];
  readonly missingIconPolicy?: "fallback" | "error";
}

type RawConfig = Omit<MoeiconsConfigFile, "icons" | "schemaVersion" | "themes"> & {
  readonly schemaVersion?: unknown;
  readonly icons?: unknown;
  readonly themes?: unknown;
};

export type ConfigLoadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unsupported"; readonly version: number }
  | { readonly kind: "ok"; readonly config: MoeiconsConfigFile };

export const SUPPORTED_FILENAMES = [
  "moeicons.config.jsonc",
  "moeicons.config.json",
  "moeicons.config.ts",
  "moeicons.config.js",
] as const;

export function findConfigFile(root: string): string | undefined {
  for (const name of SUPPORTED_FILENAMES) {
    if (existsSync(join(root, name))) return join(root, name);
  }
  return undefined;
}

function parseJsonc(text: string): { value?: unknown; errors: readonly ParseError[] } {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  return { value, errors };
}

function flattenIcons(value: unknown): readonly string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("icons must be an array or prefix-group object");
  }
  const groups = value as Record<string, unknown>;
  const result: string[] = [];
  for (const prefix of Object.keys(groups).sort()) {
    const group = groups[prefix];
    if (!Array.isArray(group) || !group.every((item) => typeof item === "string")) {
      throw new Error(`icons.${prefix} must be an array of icon IDs`);
    }
    result.push(...group);
  }
  return result;
}

function validateConfig(raw: unknown): MoeiconsConfigFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config must be an object");
  const config = raw as RawConfig;
  if (config.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (config.tier !== "free" && config.tier !== "pro") throw new Error("tier must be free or pro");
  if (config.framework !== "react" && config.framework !== "vue") throw new Error("framework must be react or vue");
  if (typeof config.outputDir !== "string" || config.outputDir.length === 0) throw new Error("outputDir is required");
  if (typeof config.defaultTheme !== "string" || config.defaultTheme.length === 0) throw new Error("defaultTheme is required");
  if (typeof config.themes !== "object" || config.themes === null || Array.isArray(config.themes)) {
    throw new Error("themes must be an object");
  }
  const themes: Record<string, MoeiconsThemeConfig> = {};
  for (const [name, value] of Object.entries(config.themes)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`theme ${name} is invalid`);
    const theme = value as unknown as Record<string, unknown>;
    if (typeof theme.styleGroup !== "string") throw new Error(`theme ${name}.styleGroup is required`);
    const group = findCatalogStyleGroup(theme.styleGroup);
    if (!group) throw new Error(`unknown style group "${theme.styleGroup}"`);
    if (!group.tiers.includes(config.tier)) throw new Error(`style group "${group.id}" is not available in ${config.tier} tier`);
    const format = typeof theme.format === "string" ? theme.format : undefined;
    if (format !== undefined && (format !== "svg" && format !== "webp" && format !== "png")) throw new Error(`theme ${name}.format is invalid`);
    const imageSize = typeof theme.imageSize === "number" ? theme.imageSize : undefined;
    if (imageSize !== undefined && ![64, 128, 256, 512].includes(imageSize)) throw new Error(`theme ${name}.imageSize is invalid`);
    if (group.type !== "bitmap" && ((format !== undefined && format !== "svg") || imageSize !== undefined)) throw new Error(`SVG theme ${name} cannot define bitmap options`);
    if (group.type === "bitmap" && format !== undefined && !group.formats.includes(format)) throw new Error(`format ${format} is unavailable for ${group.id}`);
    if (group.type === "bitmap" && imageSize !== undefined && !group.imageSizes.includes(imageSize)) throw new Error(`imageSize ${imageSize} is unavailable for ${group.id}`);
    themes[name] = {
      styleGroup: theme.styleGroup,
      ...(Array.isArray(theme.styles) && theme.styles.every((item) => typeof item === "string") ? { styles: theme.styles } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(imageSize !== undefined ? { imageSize: imageSize as 64 | 128 | 256 | 512 } : {}),
      ...(typeof theme.defaultSize === "number" ? { defaultSize: theme.defaultSize } : {}),
      ...(typeof theme.strokeWidth === "number" ? { strokeWidth: theme.strokeWidth } : {}),
      ...(typeof theme.className === "string" ? { className: theme.className } : {}),
    };
  }
  if (!(config.defaultTheme in themes)) throw new Error(`defaultTheme "${config.defaultTheme}" is not defined`);
  const icons = flattenIcons(config.icons);
  for (const iconId of icons) if (!findCatalogIcon(iconId)) throw new Error(`unknown icon "${iconId}"`);
  return {
    schemaVersion: 1,
    tier: config.tier,
    framework: config.framework,
    outputDir: config.outputDir,
    defaultTheme: config.defaultTheme,
    themes,
    icons,
    ...(config.missingIconPolicy !== undefined ? { missingIconPolicy: config.missingIconPolicy } : {}),
  };
}

export function readMoeiconsConfig(root: string): ConfigLoadResult {
  const configPath = findConfigFile(root);
  if (!configPath) return { kind: "missing" };
  if (!configPath.endsWith(".json") && !configPath.endsWith(".jsonc")) {
    return { kind: "invalid", message: "TS/JS config requires transpilation; use moeicons.config.jsonc" };
  }
  const parsed = parseJsonc(readFileSync(configPath, "utf8"));
  if (parsed.errors.length > 0 || parsed.value === undefined) return { kind: "invalid", message: `cannot parse ${configPath}` };
  const version = typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
    ? (parsed.value as Record<string, unknown>).schemaVersion
    : undefined;
  if (typeof version === "number" && version !== 1) return { kind: "unsupported", version };
  try {
    return { kind: "ok", config: validateConfig(parsed.value) };
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

export function mergeMoeiconsConfig(current: MoeiconsConfigFile, patch: Partial<MoeiconsConfigFile>): MoeiconsConfigFile {
  return {
    ...current,
    ...patch,
    schemaVersion: 1,
    themes: patch.themes ?? current.themes,
    icons: patch.icons ?? current.icons,
  };
}

export function createMoeiconsConfig(options: {
  framework: "react" | "vue";
  tier?: "free" | "pro";
  outputDir?: string;
  icons?: readonly string[];
  themes?: Readonly<Record<string, MoeiconsThemeConfig>>;
}): MoeiconsConfigFile {
  const tier = options.tier ?? "free";
  return {
    schemaVersion: 1,
    tier,
    framework: options.framework,
    outputDir: options.outputDir ?? "src/moeicons",
    defaultTheme: "outline",
    themes: options.themes ?? { outline: { styleGroup: "moe-outline", className: "text-zinc-700" } },
    icons: options.icons ?? [],
    missingIconPolicy: "fallback",
  };
}

/** Render the editable, grouped JSONC skeleton used by `init`. */
export function renderMoeiconsConfigJsonc(options: {
  framework: "react" | "vue";
  tier?: "free" | "pro";
}): string {
  const config = createMoeiconsConfig(options);
  const groups = new Map<string, string[]>();
  for (const icon of catalog.icons) {
    const ids = groups.get(icon.prefix) ?? [];
    ids.push(icon.id);
    groups.set(icon.prefix, ids);
  }
  const iconLines = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([prefix, ids]) => [
    `    // ${prefix} icons`,
    `    ${JSON.stringify(prefix)}: [`,
    ...ids.map((id) => `      ${JSON.stringify(id)},`),
    "    ],",
  ]);
  return [
    "{",
    `  "schemaVersion": ${config.schemaVersion},`,
    `  "tier": ${JSON.stringify(config.tier)},`,
    `  "framework": ${JSON.stringify(config.framework)},`,
    `  "outputDir": ${JSON.stringify(config.outputDir)},`,
    `  "defaultTheme": ${JSON.stringify(config.defaultTheme)},`,
    "  \"themes\": {",
    "    \"outline\": {",
    "      \"styleGroup\": \"moe-outline\",",
    "      \"format\": \"svg\"",
    "    }",
    "  },",
    "  // Comment out individual IDs or a complete prefix group to exclude it.",
    "  \"icons\": {",
    ...iconLines,
    "  },",
    "  \"missingIconPolicy\": \"fallback\"",
    "}",
    "",
  ].join("\n");
}
