'use strict';

// Canonical config object validator / in-memory migrator.
//
// Reads a parsed config value (already JSONC-decoded by the caller) in schema
// v1/v2/v3, validates fields, and normalizes to an in-memory v3 model. Higher
// versions are `unsupported` with zero writes. Path fields must be POSIX
// relative and reject absolute paths, `..`, NUL and backslash escapes.

const VERSION = 3;

const ALLOWED_COMMON_KEYS = new Set([
  'schemaVersion',
  'tier',
  'target',
  'outputDir',
  'defaultTheme',
  'themes',
  'icons',
  'missingIconPolicy',
  'integration',
]);

const ALLOWED_THEME_KEYS = new Set([
  'styleGroup',
  'styles',
  'format',
  'imageSize',
  'defaultSize',
  'strokeWidth',
  'className',
]);

const TARGETS = new Set(['react', 'vue', 'vanilla', 'assets']);
const ADAPTERS = new Set([
  'vite-react',
  'next-app',
  'next-pages',
  'vite-vue',
  'nuxt',
  'vanilla',
  'assets-only',
]);
const FORMATS = new Set(['svg', 'webp', 'png']);
const IMAGE_SIZES = new Set([64, 128, 256, 512]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
  return { ok: false, kind: 'invalid', message };
}

function unsupported(version) {
  return { ok: false, kind: 'unsupported', version };
}

/** Reject absolute paths, `..`, NUL and backslash escapes (POSIX relative only). */
function checkPath(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${field} must be a non-empty string`);
  }
  if (value.includes('\0') || value.includes('\\')) {
    return fail(`${field} must be a POSIX relative path (no backslash/NUL)`);
  }
  if (value.startsWith('/')) {
    return fail(`${field} must be relative, not absolute`);
  }
  const segments = value.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    return fail(`${field} must not contain '.' or '..' segments`);
  }
  return null;
}

function flattenIcons(value) {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  if (!isRecord(value)) {
    throw new Error('icons must be an array or prefix-group object');
  }
  const result = [];
  for (const prefix of Object.keys(value).sort()) {
    const group = value[prefix];
    if (!Array.isArray(group) || !group.every((item) => typeof item === 'string')) {
      throw new Error(`icons.${prefix} must be an array of icon IDs`);
    }
    result.push(...group);
  }
  return result;
}

function findGroup(id, catalog) {
  return (catalog.styleGroups || []).find((g) => g.id === id);
}

function findIcon(id, catalog) {
  return (catalog.icons || []).find((icon) => icon.id === id);
}

/** Validate + normalize into the v3 in-memory model. */
function validateConfig(raw, catalog) {
  if (!isRecord(raw)) return fail('config must be an object');
  const version = raw.schemaVersion;
  if (typeof version !== 'number') return fail('schemaVersion must be a number');
  if (version !== 1 && version !== 2 && version !== 3) return unsupported(version);

  // Common unknown-field rejection per version.
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_COMMON_KEYS.has(key)) {
      if (key === 'framework' && version === 1) continue;
      return fail(`unknown config field "${key}"`);
    }
  }

  if (raw.tier !== 'free' && raw.tier !== 'pro') return fail('tier must be free or pro');
  if (typeof raw.outputDir !== 'string' || raw.outputDir.length === 0) {
    return fail('outputDir is required');
  }

  const pathCheck = checkPath(raw.outputDir, 'outputDir');
  if (pathCheck) return pathCheck;

  let target;
  if (version === 1) {
    if (raw.framework !== 'react' && raw.framework !== 'vue') {
      return fail('framework must be react or vue (schema v1)');
    }
    target = raw.framework;
  } else {
    if (!TARGETS.has(raw.target)) return fail('target must be react, vue, vanilla, or assets');
    target = raw.target;
  }

  if (typeof raw.defaultTheme !== 'string' || raw.defaultTheme.length === 0) {
    return fail('defaultTheme is required');
  }
  if (
    raw.missingIconPolicy !== undefined &&
    raw.missingIconPolicy !== 'fallback' &&
    raw.missingIconPolicy !== 'error'
  ) {
    return fail('missingIconPolicy must be "fallback" or "error"');
  }
  if (!isRecord(raw.themes)) return fail('themes must be an object');

  const themes = {};
  for (const [name, value] of Object.entries(raw.themes)) {
    if (!isRecord(value)) return fail(`theme ${name} is invalid`);
    for (const key of Object.keys(value)) {
      if (!ALLOWED_THEME_KEYS.has(key)) return fail(`unknown field "${key}" in theme "${name}"`);
    }
    const group = findGroup(value.styleGroup, catalog);
    if (!group) return fail(`unknown style group "${value.styleGroup}"`);
    if (!group.tiers.includes(raw.tier)) {
      return fail(`style group "${group.id}" is not available in ${raw.tier} tier`);
    }
    const format = typeof value.format === 'string' ? value.format : undefined;
    if (format !== undefined && !FORMATS.has(format)) return fail(`theme ${name}.format is invalid`);
    const imageSize = typeof value.imageSize === 'number' ? value.imageSize : undefined;
    if (imageSize !== undefined && !IMAGE_SIZES.has(imageSize)) {
      return fail(`theme ${name}.imageSize is invalid`);
    }
    if (
      group.type !== 'bitmap' &&
      ((format !== undefined && format !== 'svg') || imageSize !== undefined)
    ) {
      return fail(`SVG theme ${name} cannot define bitmap options`);
    }
    if (
      group.type === 'bitmap' &&
      format !== undefined &&
      !(group.formats || []).includes(format)
    ) {
      return fail(`format ${format} is unavailable for ${group.id}`);
    }
    if (
      group.type === 'bitmap' &&
      imageSize !== undefined &&
      !(group.imageSizes || []).includes(imageSize)
    ) {
      return fail(`imageSize ${imageSize} is unavailable for ${group.id}`);
    }
    themes[name] = {
      styleGroup: value.styleGroup,
      ...(format !== undefined ? { format } : {}),
      ...(imageSize !== undefined ? { imageSize } : {}),
      ...(typeof value.defaultSize === 'number' ? { defaultSize: value.defaultSize } : {}),
      ...(typeof value.strokeWidth === 'number' ? { strokeWidth: value.strokeWidth } : {}),
      ...(typeof value.className === 'string' ? { className: value.className } : {}),
    };
  }
  if (!(raw.defaultTheme in themes)) {
    return fail(`defaultTheme "${raw.defaultTheme}" is not defined`);
  }

  let icons;
  try {
    icons = flattenIcons(raw.icons);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  for (const iconId of icons) {
    if (!findIcon(iconId, catalog)) return fail(`unknown icon "${iconId}"`);
  }

  let integration;
  if (raw.integration !== undefined) {
    if (!isRecord(raw.integration)) return fail('integration must be an object');
    for (const key of Object.keys(raw.integration)) {
      if (!['adapter', 'entry', 'style'].includes(key)) {
        return fail(`unknown integration field "${key}"`);
      }
    }
    if (!ADAPTERS.has(raw.integration.adapter)) {
      return fail(`integration.adapter is not a supported adapter`);
    }
    if (raw.integration.adapter !== 'assets-only') {
      const entry = checkPath(raw.integration.entry, 'integration.entry');
      if (entry) return entry;
    } else if (raw.integration.entry !== undefined) {
      const entry = checkPath(raw.integration.entry, 'integration.entry');
      if (entry) return entry;
    }
    if (raw.integration.style !== undefined) {
      const style = checkPath(raw.integration.style, 'integration.style');
      if (style) return style;
    }
    integration = {
      adapter: raw.integration.adapter,
      ...(raw.integration.entry !== undefined ? { entry: raw.integration.entry } : {}),
      ...(raw.integration.style !== undefined ? { style: raw.integration.style } : {}),
    };
  }

  return {
    ok: true,
    warnings:
      version === 1
        ? ['config schema v1 migrated "framework" to "target"']
        : version === 2
          ? ['config schema v2 normalized to in-memory v3']
          : [],
    config: {
      schemaVersion: VERSION,
      tier: raw.tier,
      target,
      outputDir: raw.outputDir,
      defaultTheme: raw.defaultTheme,
      themes,
      icons,
      ...(raw.missingIconPolicy !== undefined
        ? { missingIconPolicy: raw.missingIconPolicy }
        : {}),
      ...(integration !== undefined ? { integration } : {}),
    },
  };
}

module.exports = { validateConfig, VERSION, ADAPTERS };
