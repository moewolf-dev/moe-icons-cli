/**
 * G0/G1/G2: styleGroupId vs resourceVariantId.
 * Variant ids are deterministic: `<styleGroupId>-<webp|png>-<64|128|256|512>`.
 * Parse from the right: size, then format, remainder is styleGroupId.
 */

export const BITMAP_STYLE_GROUP_RE = /^moe-[a-z0-9]+(?:-[a-z0-9]+)*-3d$/;
export const BITMAP_FORMATS = ["webp", "png"] as const;
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

export function isBitmapStyleGroupId(id: string): boolean {
  return BITMAP_STYLE_GROUP_RE.test(id);
}

export function isBitmapFormat(value: string): value is BitmapFormat {
  return (BITMAP_FORMATS as readonly string[]).includes(value);
}

export function isBitmapSize(value: number): value is BitmapSize {
  return (BITMAP_SIZES as readonly number[]).includes(value);
}

/** Build a resourceVariantId; never invent aliases. */
export function buildResourceVariantId(
  styleGroupId: string,
  format: BitmapFormat = DEFAULT_BITMAP_FORMAT,
  imageSize: BitmapSize = DEFAULT_BITMAP_SIZE,
): string {
  if (!isBitmapStyleGroupId(styleGroupId)) {
    throw new Error(`styleGroupId "${styleGroupId}" is not a bitmap style group`);
  }
  return `${styleGroupId}-${format}-${imageSize}`;
}

/**
 * Parse `<styleGroupId>-<format>-<size>` from the right.
 * Rejects guessing by scanning for an arbitrary `-3d` substring.
 */
export function parseResourceVariantId(resourceVariantId: string): ResourceVariant {
  const parts = resourceVariantId.split("-");
  if (parts.length < 4) {
    throw new Error(`invalid resourceVariantId "${resourceVariantId}"`);
  }
  const sizeToken = parts[parts.length - 1] ?? "";
  const formatToken = parts[parts.length - 2] ?? "";
  const imageSize = Number(sizeToken);
  if (!isBitmapSize(imageSize)) {
    throw new Error(`invalid imageSize in resourceVariantId "${resourceVariantId}"`);
  }
  if (!isBitmapFormat(formatToken)) {
    throw new Error(`invalid format in resourceVariantId "${resourceVariantId}"`);
  }
  const styleGroupId = parts.slice(0, -2).join("-");
  if (!isBitmapStyleGroupId(styleGroupId)) {
    throw new Error(`invalid styleGroupId derived from "${resourceVariantId}"`);
  }
  return {
    styleGroupId,
    format: formatToken,
    imageSize,
    resourceVariantId: buildResourceVariantId(styleGroupId, formatToken, imageSize),
  };
}

/** Resolve format/size for a bitmap theme, applying catalog defaults when omitted. */
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
