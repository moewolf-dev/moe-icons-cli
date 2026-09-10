/**
 * MEDIA-FORMAT-V2: styleGroupId vs resourceVariantId.
 *
 * Canonical variant ids are the actual source directory names:
 * `<styleGroupId>-<imageSize>-<format>` (e.g. `moe-3d-metal-256-webp`). Parsing
 * is controlled keyword-token based, never substring based; `3d` is an ordinary
 * token. The legacy `<group ending -3d>-<format>-<size>` form is only readable
 * through the explicit `parseLegacyResourceVariantId` compatibility branch.
 */

export const BITMAP_STYLE_GROUP_RE = /^moe-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LEGACY_BITMAP_STYLE_GROUP_RE = /^moe-[a-z0-9]+(?:-[a-z0-9]+)*-3d$/;
export const BITMAP_FORMATS = ["png", "webp"] as const;
export const BITMAP_SIZES = [64, 128, 256, 512] as const;

export type BitmapFormat = (typeof BITMAP_FORMATS)[number];
export type BitmapSize = (typeof BITMAP_SIZES)[number];

export interface ResourceVariant {
  readonly styleGroupId: string;
  readonly format: BitmapFormat;
  readonly imageSize: BitmapSize;
  readonly resourceVariantId: string;
}

export const DEFAULT_BITMAP_FORMAT: BitmapFormat = "webp";
export const DEFAULT_BITMAP_SIZE: BitmapSize = 256;

export function isBitmapFormat(value: string): value is BitmapFormat {
  return (BITMAP_FORMATS as readonly string[]).includes(value);
}

export function isBitmapSize(value: number): value is BitmapSize {
  return (BITMAP_SIZES as readonly number[]).includes(value);
}

/** Build the canonical v2 resourceVariantId (`<group>-<size>-<format>`). */
export function buildResourceVariantId(
  styleGroupId: string,
  format: string = DEFAULT_BITMAP_FORMAT,
  imageSize: number = DEFAULT_BITMAP_SIZE,
): string {
  if (!BITMAP_STYLE_GROUP_RE.test(styleGroupId)) {
    throw new Error(`styleGroupId "${styleGroupId}" is not a valid style group`);
  }
  if (!isBitmapFormat(format)) throw new Error(`unsupported bitmap format "${format}"`);
  if (!isBitmapSize(imageSize)) throw new Error(`unsupported bitmap imageSize ${String(imageSize)}`);
  return `${styleGroupId}-${imageSize}-${format}`;
}

/**
 * Parse a v2 name using complete `-` tokens. Returns undefined when the name is
 * not a bitmap candidate (no format token); throws on duplicate/conflicting
 * keywords; returns undefined when the canonical rebuilt id differs (e.g. the
 * legacy format-before-size order).
 */
export function parseBitmapName(name: string): ResourceVariant | undefined {
  const tokens = name.split("-");
  const formatIndexes: number[] = [];
  const sizeIndexes: number[] = [];
  tokens.forEach((token, index) => {
    if (isBitmapFormat(token)) formatIndexes.push(index);
    if (/^(?:64|128|256|512)$/.test(token)) sizeIndexes.push(index);
  });
  if (formatIndexes.length === 0) return undefined;
  if (formatIndexes.length !== 1 || sizeIndexes.length !== 1) {
    throw new Error(`bitmap name "${name}" must contain exactly one format token and one size token`);
  }
  const format = tokens[formatIndexes[0] as number] as BitmapFormat;
  const imageSize = Number(tokens[sizeIndexes[0] as number]) as BitmapSize;
  const removed = new Set([formatIndexes[0], sizeIndexes[0]]);
  const styleGroupId = tokens.filter((_, index) => !removed.has(index)).join("-");
  if (!BITMAP_STYLE_GROUP_RE.test(styleGroupId)) {
    throw new Error(`bitmap name "${name}" derives an invalid styleGroupId "${styleGroupId}"`);
  }
  const canonical = `${styleGroupId}-${imageSize}-${format}`;
  if (canonical !== name) return undefined;
  return { styleGroupId, format, imageSize, resourceVariantId: canonical };
}

/** Parse a canonical v2 resourceVariantId or throw. */
export function parseResourceVariantId(resourceVariantId: string): ResourceVariant {
  const parsed = parseBitmapName(resourceVariantId);
  if (!parsed) throw new Error(`invalid resourceVariantId "${resourceVariantId}"`);
  return parsed;
}

/**
 * Explicit v1 compatibility branch: legacy ids are
 * `<styleGroupId ending -3d>-<format>-<size>`. Never guessed by the v2 parser.
 */
export function parseLegacyResourceVariantId(resourceVariantId: string): ResourceVariant {
  const parts = resourceVariantId.split("-");
  if (parts.length < 4) throw new Error(`invalid legacy resourceVariantId "${resourceVariantId}"`);
  const imageSize = Number(parts[parts.length - 1]);
  const format = parts[parts.length - 2] ?? "";
  const styleGroupId = parts.slice(0, -2).join("-");
  if (!isBitmapSize(imageSize)) throw new Error(`invalid imageSize in resourceVariantId "${resourceVariantId}"`);
  if (!isBitmapFormat(format)) throw new Error(`invalid format in resourceVariantId "${resourceVariantId}"`);
  if (!LEGACY_BITMAP_STYLE_GROUP_RE.test(styleGroupId)) {
    throw new Error(`invalid legacy styleGroupId derived from "${resourceVariantId}"`);
  }
  return { styleGroupId, format, imageSize, resourceVariantId };
}

/**
 * Build a canonical variant from a group id and optional format/size, applying
 * the schema defaults `webp`/`256`. Availability must still be checked against
 * the catalog by the caller (MEDIA-FORMAT-V2 D-05/B6).
 */
export function resolveResourceVariant(
  styleGroupId: string,
  options: { readonly format?: string; readonly imageSize?: number } = {},
): ResourceVariant {
  const format = options.format === undefined ? DEFAULT_BITMAP_FORMAT : options.format;
  const imageSize = options.imageSize === undefined ? DEFAULT_BITMAP_SIZE : options.imageSize;
  if (!isBitmapFormat(format)) throw new Error(`unsupported bitmap format "${format}"`);
  if (!isBitmapSize(imageSize)) throw new Error(`unsupported bitmap imageSize ${String(imageSize)}`);
  const resourceVariantId = buildResourceVariantId(styleGroupId, format, imageSize);
  return { styleGroupId, format, imageSize, resourceVariantId };
}

/** Relative managed asset path under outputDir (POSIX). */
export function assetRelativePath(resourceVariantId: string, iconId: string, format: BitmapFormat): string {
  return `assets/${resourceVariantId}/${iconId}.${format}`;
}
