import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import {
  catalog,
  findCatalogIcon,
  findCatalogStyleGroup,
  type IconCatalog,
} from "../catalog/catalog.js";
import { loadGeneratedConfigPackage } from "../config-package/generated-config.js";
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

/** User-confirmed project integration anchors (config schema v3). */
export interface MoeiconsIntegration {
  readonly adapter:
    | "vite-react"
    | "next-app"
    | "next-pages"
    | "vite-vue"
    | "nuxt"
    | "vanilla"
    | "assets-only";
  readonly entry?: string;
  readonly style?: string;
}

/**
 * Normalized config: schema version 2 with a REQUIRED `target`. Core code must
 * never see an optional or missing target — v1 files are migrated by
 * `readMoeiconsConfig` and invalid v2 files fail with a validation error
 * instead of silently defaulting to React. Schema v3 files add an optional
 * `integration` block that is preserved in memory.
 */
export interface MoeiconsConfigFile {
  readonly schemaVersion: 2 | 3;
  readonly tier: "free" | "pro";
  readonly target: Target;
  readonly outputDir: string;
  readonly defaultTheme: string;
  readonly themes: Readonly<Record<string, MoeiconsThemeConfig>>;
  readonly icons: readonly string[];
  readonly missingIconPolicy?: "fallback" | "error";
  readonly integration?: MoeiconsIntegration;
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

/** Adapter enum for schema v3 `integration`. */
export const INTEGRATION_ADAPTERS = [
  "vite-react",
  "next-app",
  "next-pages",
  "vite-vue",
  "nuxt",
  "vanilla",
  "assets-only",
] as const;
export type IntegrationAdapter = (typeof INTEGRATION_ADAPTERS)[number];

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
  "target",
  "outputDir",
  "defaultTheme",
  "themes",
  "icons",
  "missingIconPolicy",
  "integration",
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

/** Validate a `target`-based config (schema v2 or v3). Framework is rejected. */
function validateV2Config(
  raw: unknown,
  sourceCatalog: IconCatalog,
  schemaVersion: 2 | 3 = 2,
): ValidatedConfig {
  const obj = asRecord(raw);
  if (obj.framework !== undefined)
    throw new Error('framework is only supported in schemaVersion 1; use target');
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_COMMON_KEYS.has(key)) {
      throw new Error(`unknown config field "${key}"`);
    }
  }
  if (obj.target === undefined) throw new Error("target is required");
  const target = normalizeTarget(obj.target);
  const common = requireCommonConfigFields(obj, sourceCatalog);
  return {
    config: {
      schemaVersion,
      tier: common.tier,
      target,
      outputDir: common.outputDir,
      defaultTheme: common.defaultTheme,
      themes: common.themes,
      icons: common.icons,
      ...(common.missingIconPolicy !== undefined
        ? { missingIconPolicy: common.missingIconPolicy }
        : {}),
      ...(obj.integration !== undefined
        ? { integration: validateIntegration(obj.integration) }
        : {}),
    },
    warnings: common.warnings,
  };
}

const POSIX_RELATIVE_OK = /^(?!\.{1,2}(?:$|\/))(?![A-Za-z]:[\\/])(?!\/)(?!.*\\)[^\0]+$/;

function validateIntegration(value: unknown): MoeiconsIntegration {
  const record = asRecord(value);
  for (const key of Object.keys(record)) {
    if (!["adapter", "entry", "style"].includes(key)) {
      throw new Error(`unknown integration field "${key}"`);
    }
  }
  if (!INTEGRATION_ADAPTERS.includes(record.adapter as IntegrationAdapter)) {
    throw new Error(`integration.adapter is not a supported adapter`);
  }
  const adapter = record.adapter as IntegrationAdapter;
  const checkRel = (field: unknown, name: string): string | undefined => {
    if (field === undefined) return undefined;
    if (typeof field !== "string" || !POSIX_RELATIVE_OK.test(field)) {
      throw new Error(`${name} must be a POSIX-relative path without .. or escapes`);
    }
    return field;
  };
  const entry = checkRel(record.entry, "integration.entry");
  const style = checkRel(record.style, "integration.style");
  if (adapter !== "assets-only" && entry === undefined) {
    throw new Error(`integration.entry is required for adapter ${adapter}`);
  }
  return {
    adapter,
    ...(entry !== undefined ? { entry } : {}),
    ...(style !== undefined ? { style } : {}),
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
  if (obj.target !== undefined || obj.integration !== undefined)
    throw new Error("v1 config cannot set target or integration; migrate to schema v2/v3");
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
    return { kind: "invalid", message: "schemaVersion must be 1, 2, or 3" };
  }
  if (version !== 1 && version !== 2 && version !== 3) return { kind: "unsupported", version };
  try {
    if (version === 1) {
      const validated = validateV1Config(parsed.value, sourceCatalog);
      validated.warnings.unshift('config schema v1 migrated "framework" to "target"');
      return { kind: "ok", config: validated.config, warnings: validated.warnings };
    }
    const validated = validateV2Config(parsed.value, sourceCatalog, version);
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

/**
 * Render the editable, grouped JSONC skeleton used by `init`.
 *
 * Delegates to the canonical renderer bundled from moe-icons-code-library
 * `config-package` (see `src/config-package/generated` + SOURCE.json). The CLI
 * no longer keeps a second full template; a schema v1/v2 default file is
 * produced unless an integration result is supplied (v3 + `integration`).
 */
export function renderMoeiconsConfigJsonc(options: {
  target?: Target;
  /** Legacy v1 alias; still emits a `target` field. */
  framework?: "react" | "vue";
  tier?: "free" | "pro";
}): string {
  const generated = loadGeneratedConfigPackage();
  return generated.renderMoeiconsConfigJsonc({ ...options, catalog });
}