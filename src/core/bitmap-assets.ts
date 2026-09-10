import {
  assetRelativePath,
  parseLegacyResourceVariantId,
  parseResourceVariantId,
  type BitmapFormat,
  type ResourceVariant,
} from "./resource-variant.js";

export interface SelectedBitmapAsset {
  /** POSIX path relative to outputDir, e.g. assets/moe-3d-metal-256-webp/ui-search.webp */
  readonly destRel: string;
  readonly bytes: Uint8Array;
  readonly resourceVariantId: string;
  readonly iconId: string;
}

export interface MatchBitmapOptions {
  /**
   * Media contract of the archive being read. Defaults to 2 (canonical actual
   * directory names). Set to 1 to read frozen v1 artifacts through the explicit
   * legacy parser; the two parsers are never mixed.
   */
  readonly mediaContractVersion?: 1 | 2;
}

function normalizeArchivePath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Identify a bitmap file inside a free/pro archive by parsing a directory
 * segment as a resourceVariantId. v2 uses controlled keyword tokens; v1 uses the
 * explicit legacy `<group>-<format>-<size>` branch.
 */
export function matchArchiveBitmapFile(
  archivePath: string,
  options: MatchBitmapOptions = {},
): { readonly variant: ResourceVariant; readonly iconId: string } | undefined {
  const mediaContractVersion = options.mediaContractVersion ?? 2;
  const cleaned = normalizeArchivePath(archivePath);
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const file = parts[parts.length - 1] ?? "";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const format = file.slice(dot + 1) as BitmapFormat;
  const iconId = file.slice(0, dot);
  if (!iconId || iconId.includes("..")) return undefined;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i] ?? "";
    try {
      const variant =
        mediaContractVersion === 1
          ? parseLegacyResourceVariantId(segment)
          : parseResourceVariantId(segment);
      if (variant.format !== format) continue;
      return { variant, iconId };
    } catch {
      continue;
    }
  }
  return undefined;
}

export type SelectBitmapAssetsResult =
  | { readonly ok: true; readonly assets: readonly SelectedBitmapAsset[]; readonly skipped: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Keep only archive files that belong to the requested variants and selected
 * icons. Other sizes/formats stay in the tarball/cache and are not written.
 */
export function selectBitmapVariantAssets(
  archiveFiles: Readonly<Record<string, Uint8Array>>,
  variants: readonly ResourceVariant[],
  iconIds: readonly string[],
  options: MatchBitmapOptions = {},
): SelectBitmapAssetsResult {
  const wanted = new Map(variants.map((variant) => [variant.resourceVariantId, variant]));
  const iconSet = new Set(iconIds);
  const skipped: string[] = [];
  const chosen = new Map<string, SelectedBitmapAsset>();

  for (const [archivePath, bytes] of Object.entries(archiveFiles)) {
    const matched = matchArchiveBitmapFile(archivePath, options);
    if (!matched) continue;
    if (!wanted.has(matched.variant.resourceVariantId)) {
      skipped.push(archivePath);
      continue;
    }
    if (!iconSet.has(matched.iconId)) {
      skipped.push(archivePath);
      continue;
    }
    const destRel = assetRelativePath(matched.variant.resourceVariantId, matched.iconId, matched.variant.format);
    chosen.set(destRel, {
      destRel,
      bytes,
      resourceVariantId: matched.variant.resourceVariantId,
      iconId: matched.iconId,
    });
  }

  const errors: string[] = [];
  for (const variant of variants) {
    for (const iconId of iconIds) {
      const destRel = assetRelativePath(variant.resourceVariantId, iconId, variant.format);
      if (!chosen.has(destRel)) {
        errors.push(
          `bitmap asset missing for icon "${iconId}" variant "${variant.resourceVariantId}"`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, assets: [...chosen.values()], skipped };
}
