import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import {
  catalog,
  findCatalogIcon,
  findCatalogStyleGroup,
  type IconCatalog,
} from "../catalog/catalog.js";
import type { Target } from "../commands/parser.js";

export interface MoeiconsThemeConfig {
  readonly styleGroup: string;
  readonly styles?: readonly string[];
  readonly format?: "svg" | "webp" | "png";
  readonly imageSize?: 64 | 128 | 256 | 512;
  readonly defaultSize?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
}

/**
 * Normalized config: schema version 2 with a REQUIRED `target`. Core code must
 * never see an optional or missing target — v1 files are migrated by
 * `readMoeiconsConfig` and invalid v2 files fail with a validation error
 * instead of silently defaulting to React.
 */
export interface MoeiconsConfigFile {
  readonly schemaVersion: 2;
  readonly tier: "free" | "pro";
  readonly target: Target;
  readonly outputDir: string;
  readonly defaultTheme: string;
  readonly themes: Readonly<Record<string, MoeiconsThemeConfig>>;
  readonly icons: readonly string[];
  readonly missingIconPolicy?: "fallback" | "error";
}

/**
 * Legacy v1 input shape. Reads normalize it into a `MoeiconsConfigFile` v2 by
 * migrating `framework` to `target`. Core code never receives this type.
 */
export interface LegacyConfigInput {
  readonly schemaVersion: 1;
  readonly tier: "free" | "pro";
  readonly framework: "react" | "vue";
  readonly outputDir: string;
  readonly defaultTheme: string;
  readonly themes: Readonly<Record<string, MoeiconsThemeConfig>>;
  readonly icons: readonly string[];
  readonly missingIconPolicy?: "fallback" | "error";
}

export type ConfigLoadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unsupported"; readonly version: number }
  | {
      readonly kind: "ok";
      readonly config: MoeiconsConfigFile;
      readonly warnings: readonly string[];
    };

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
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
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

const ALLOWED_COMMON_KEYS = new Set([
  "schemaVersion",
  "tier",
  "outputDir",
  "defaultTheme",
  "themes",
  "icons",
  "missingIconPolicy",
]);

const ALLOWED_THEME_KEYS = new Set([
  "styleGroup",
  "styles",
  "format",
  "imageSize",
  "defaultSize",
  "strokeWidth",
  "className",
]);

interface ValidatedConfig {
  readonly config: MoeiconsConfigFile;
  readonly warnings: string[];
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("config must be an object");
  return raw as Record<string, unknown>;
}

function requireCommonConfigFields(obj: Record<string, unknown>, sourceCatalog: IconCatalog): {
  warnings: string[];
  tier: "free" | "pro";
  outputDir: string;
  defaultTheme: string;
  themes: Readonly<Record<string, MoeiconsThemeConfig>>;
  icons: readonly string[];
  missingIconPolicy?: "fallback" | "error";
} {
  const warnings: string[] = [];
  if (obj.tier !== "free" && obj.tier !== "pro") throw new Error("tier must be free or pro");
  const tier = obj.tier;
  if (typeof obj.outputDir !== "string" || obj.outputDir.length === 0)
    throw new Error("outputDir is required");
  if (typeof obj.defaultTheme !== "string" || obj.defaultTheme.length === 0)
    throw new Error("defaultTheme is required");
  if (typeof obj.themes !== "object" || obj.themes === null || Array.isArray(obj.themes)) {
    throw new Error("themes must be an object");
  }
  if (
    obj.missingIconPolicy !== undefined &&
    obj.missingIconPolicy !== "fallback" &&
    obj.missingIconPolicy !== "error"
  ) {
    throw new Error(`missingIconPolicy must be "fallback" or "error"`);
  }

  const themes: Record<string, MoeiconsThemeConfig> = {};
  for (const [name, value] of Object.entries(obj.themes)) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`theme ${name} is invalid`);
    const theme = value as Record<string, unknown>;

    // Reject unknown theme fields.
    for (const key of Object.keys(theme)) {
      if (!ALLOWED_THEME_KEYS.has(key))
        throw new Error(`unknown field "${key}" in theme "${name}"`);
    }

    if (typeof theme.styleGroup !== "string")
      throw new Error(`theme ${name}.styleGroup is required`);
    const group = findCatalogStyleGroup(theme.styleGroup, sourceCatalog);
    if (!group) throw new Error(`unknown style group "${theme.styleGroup}"`);
    if (!group.tiers.includes(tier)) {
      throw new Error(`style group "${group.id}" is not available in ${tier} tier`);
    }

    // styles[] is deprecated — still accepted for migration but warns.
    if (Array.isArray(theme.styles) && theme.styles.length > 0) {
      warnings.push(
        `theme "${name}": "styles" is deprecated and has no effect; remove it from your config`,
      );
    }

    const format = typeof theme.format === "string" ? theme.format : undefined;
    if (format !== undefined && format !== "svg" && format !== "webp" && format !== "png") {
      throw new Error(`theme ${name}.format is invalid`);
    }
    const imageSize = typeof theme.imageSize === "number" ? theme.imageSize : undefined;
    if (imageSize !== undefined && ![64, 128, 256, 512].includes(imageSize)) {
      throw new Error(`theme ${name}.imageSize is invalid`);
    }
    if (
      group.type !== "bitmap" &&
      ((format !== undefined && format !== "svg") || imageSize !== undefined)
    ) {
      throw new Error(`SVG theme ${name} cannot define bitmap options`);
    }
    if (group.type === "bitmap" && format !== undefined && !group.formats.includes(format)) {
      throw new Error(`format ${format} is unavailable for ${group.id}`);
    }
    if (
      group.type === "bitmap" &&
      imageSize !== undefined &&
      !group.imageSizes.includes(imageSize)
    ) {
      throw new Error(`imageSize ${imageSize} is unavailable for ${group.id}`);
    }
    themes[name] = {
      styleGroup: theme.styleGroup,
      ...(format !== undefined ? { format } : {}),
      ...(imageSize !== undefined ? { imageSize: imageSize as 64 | 128 | 256 | 512 } : {}),
      ...(typeof theme.defaultSize === "number" ? { defaultSize: theme.defaultSize } : {}),
      ...(typeof theme.strokeWidth === "number" ? { strokeWidth: theme.strokeWidth } : {}),
      ...(typeof theme.className === "string" ? { className: theme.className } : {}),
    };
  }
  if (!(obj.defaultTheme in themes))
    throw new Error(`defaultTheme "${obj.defaultTheme}" is not defined`);
  const icons = flattenIcons(obj.icons);
  for (const iconId of icons)
    if (!findCatalogIcon(iconId, sourceCatalog)) throw new Error(`unknown icon "${iconId}"`);
  return {
    warnings,
    tier,
    outputDir: obj.outputDir,
    defaultTheme: obj.defaultTheme,
    themes,
    icons,
    ...(obj.missingIconPolicy !== undefined
      ? { missingIconPolicy: obj.missingIconPolicy }
      : {}),
  };
}

function normalizeTarget(value: unknown): Target {
  if (value === "react" || value === "vue" || value === "vanilla" || value === "assets") {
    return value;
  }
  throw new Error("target must be react, vue, vanilla, or assets");
}

/** Validate a schema version 2 config: target is required, framework is rejected. */
function validateV2Config(raw: unknown, sourceCatalog: IconCatalog): ValidatedConfig {
  const obj = asRecord(raw);
  if (obj.framework !== undefined)
    throw new Error('framework is only supported in schemaVersion 1; use target');
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_COMMON_KEYS.has(key) && key !== "target") {
      throw new Error(`unknown config field "${key}"`);
    }
  }
  if (obj.target === undefined) throw new Error("target is required");
  const target = normalizeTarget(obj.target);
  const common = requireCommonConfigFields(obj, sourceCatalog);
  return {
    config: {
      schemaVersion: 2,
      tier: common.tier,
      target,
      outputDir: common.outputDir,
      defaultTheme: common.defaultTheme,
      themes: common.themes,
      icons: common.icons,
      ...(common.missingIconPolicy !== undefined
        ? { missingIconPolicy: common.missingIconPolicy }
        : {}),
    },
    warnings: common.warnings,
  };
}

/** Validate a legacy schema version 1 config: framework is required, target is rejected. */
function validateV1Config(raw: unknown, sourceCatalog: IconCatalog): ValidatedConfig {
  const obj = asRecord(raw);
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_COMMON_KEYS.has(key) && key !== "framework") {
      throw new Error(`unknown config field "${key}"`);
    }
  }
  if (obj.target !== undefined)
    throw new Error("v1 config cannot set target; migrate to schemaVersion 2");
  if (obj.framework !== "react" && obj.framework !== "vue")
    throw new Error("framework must be react or vue");
  const common = requireCommonConfigFields(obj, sourceCatalog);
  return {
    config: {
      schemaVersion: 2,
      tier: common.tier,
      target: obj.framework,
      outputDir: common.outputDir,
      defaultTheme: common.defaultTheme,
      themes: common.themes,
      icons: common.icons,
      ...(common.missingIconPolicy !== undefined
        ? { missingIconPolicy: common.missingIconPolicy }
        : {}),
    },
    warnings: common.warnings,
  };
}

export function readMoeiconsConfig(
  root: string,
  sourceCatalog: IconCatalog = catalog,
): ConfigLoadResult {
  const configPath = findConfigFile(root);
  if (!configPath) return { kind: "missing" };
  if (!configPath.endsWith(".json") && !configPath.endsWith(".jsonc")) {
    return {
      kind: "invalid",
      message: "TS/JS config requires transpilation; use moeicons.config.jsonc",
    };
  }
  const parsed = parseJsonc(readFileSync(configPath, "utf8"));
  if (parsed.errors.length > 0 || parsed.value === undefined)
    return { kind: "invalid", message: `cannot parse ${configPath}` };
  const version =
    typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, unknown>).schemaVersion
      : undefined;
  if (typeof version !== "number") {
    return { kind: "invalid", message: "schemaVersion must be 1 or 2" };
  }
  if (version !== 1 && version !== 2) return { kind: "unsupported", version };
  try {
    if (version === 1) {
      const validated = validateV1Config(parsed.value, sourceCatalog);
      validated.warnings.unshift('config schema v1 migrated "framework" to "target"');
      return { kind: "ok", config: validated.config, warnings: validated.warnings };
    }
    const validated = validateV2Config(parsed.value, sourceCatalog);
    return { kind: "ok", config: validated.config, warnings: validated.warnings };
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolve the canonical v2 target from either a normalized v2 or legacy v1 input. */
function targetFromInput(current: MoeiconsConfigFile | LegacyConfigInput): Target {
  if ("target" in current) return current.target;
  return current.framework;
}

export function mergeMoeiconsConfig(
  current: MoeiconsConfigFile | LegacyConfigInput,
  patch: Partial<Omit<MoeiconsConfigFile, "schemaVersion">>,
): MoeiconsConfigFile {
  return {
    schemaVersion: 2,
    tier: patch.tier ?? current.tier,
    target: patch.target ?? targetFromInput(current),
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

export function createMoeiconsConfig(options: {
  target?: Target;
  /** Legacy v1 alias; still emits a v2 `target`. */
  framework?: "react" | "vue";
  tier?: "free" | "pro";
  outputDir?: string;
  icons?: readonly string[];
  themes?: Readonly<Record<string, MoeiconsThemeConfig>>;
}): MoeiconsConfigFile {
  const tier = options.tier ?? "free";
  return {
    schemaVersion: 2,
    tier,
    target: options.target ?? options.framework ?? "react",
    outputDir: options.outputDir ?? "src/moeicons",
    defaultTheme: "outline",
    themes: options.themes ?? {
      outline: { styleGroup: "moe-outline", className: "text-zinc-700" },
    },
    icons: options.icons ?? [],
    missingIconPolicy: "fallback",
  };
}

/** Render the editable, grouped JSONC skeleton used by `init`. */
export function renderMoeiconsConfigJsonc(options: {
  target?: Target;
  /** Legacy v1 alias; still emits a v2 `target`. */
  framework?: "react" | "vue";
  tier?: "free" | "pro";
}): string {
  const tier = options.tier ?? "free";
  const target = options.target ?? options.framework ?? "react";

  // Collect style groups available for this tier, ordered by id.
  const availableGroups = catalog.styleGroups
    .filter((g) => g.tiers.includes(tier))
    .sort((a, b) => a.id.localeCompare(b.id));

  const defaultThemeName = "outline";

  // Build theme entries: one per available SVG group (bitmap groups get their
  // own entry with format/imageSize annotations).
  const themeLines: string[] = [];
  for (const group of availableGroups) {
    const themeName = group.id.replace(/^moe-/, "");
    if (group.type === "bitmap") {
      // List available format/imageSize combinations as inline comments.
      const formatsComment = `// format options: ${group.formats.join(", ")}`;
      const sizesComment = `// imageSize options: ${group.imageSizes.join(", ")}`;
      themeLines.push(
        `    // ${themeName} — bitmap style (${group.id})`,
        `    // ${formatsComment}`,
        `    // ${sizesComment}`,
        `    // ${JSON.stringify(themeName)}: {`,
        `    //   "styleGroup": ${JSON.stringify(group.id)},`,
        `    //   "format": "webp",`,
        `    //   "imageSize": 256`,
        `    // },`,
      );
    } else {
      themeLines.push(
        `    ${JSON.stringify(themeName)}: {`,
        `      "styleGroup": ${JSON.stringify(group.id)}`,
        `    },`,
      );
    }
  }

  // Collect icons: only those available in at least one style group of this tier,
  // grouped by prefix and default-selected (all selected).
  const tierGroupIds = new Set(availableGroups.map((g) => g.id));
  const groups = new Map<string, string[]>();
  for (const icon of catalog.icons) {
    if (!icon.availableIn.some((sg) => tierGroupIds.has(sg))) continue;
    const ids = groups.get(icon.prefix) ?? [];
    ids.push(icon.id);
    groups.set(icon.prefix, ids);
  }
  const iconLines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([prefix, ids]) => [
      `    // ${prefix} icons`,
      `    ${JSON.stringify(prefix)}: [`,
      ...ids.map((id) => `      ${JSON.stringify(id)},`),
      "    ],",
    ]);

  return [
    "{",
    `  "schemaVersion": 2,`,
    `  "tier": ${JSON.stringify(tier)},`,
    `  "target": ${JSON.stringify(target)},`,
    `  "outputDir": "src/moeicons",`,
    `  "defaultTheme": ${JSON.stringify(defaultThemeName)},`,
    '  "themes": {',
    ...themeLines,
    `    // Set defaultTheme above to one of: ${availableGroups
      .filter((g) => g.type !== "bitmap")
      .map((g) => JSON.stringify(g.id.replace(/^moe-/, "")))
      .join(", ")}`,
    "  },",
    "  // Comment out individual IDs or a complete prefix group to exclude it.",
    '  "icons": {',
    ...iconLines,
    "  },",
    '  "missingIconPolicy": "fallback"',
    "}",
    "",
  ].join("\n");
}