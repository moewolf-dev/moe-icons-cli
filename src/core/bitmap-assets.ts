import {
  assetRelativePath,
  parseLegacyResourceVariantId,
  parseResourceVariantId,
  type BitmapFormat,
  type ResourceVariant,
} from "./resource-variant.js";

export interface SelectedBitmapAsset {
  /** POSIX path relative to outputDir, e.g. assets/example-bitmap-style-256-webp/ui-search.webp */
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
  /** Exact variant/icon pairs, used when a missing theme falls back to another group. */
  readonly requestedPairs?: readonly { readonly variantId: string; readonly iconId: string }[];
}

function normalizeArchivePath(rel: string): string {
  return rel.replace(/^\.\//, "");
}

/**
 * Identify a bitmap file at its canonical archive location
 * `assets/<resourceVariantId>/<iconId>.<format>`. v2 uses controlled keyword
 * tokens; v1 uses the explicit legacy `<group>-<format>-<size>` branch.
 */
export function matchArchiveBitmapFile(
  archivePath: string,
  options: MatchBitmapOptions = {},
): { readonly variant: ResourceVariant; readonly iconId: string } | undefined {
  const mediaContractVersion = options.mediaContractVersion ?? 2;
  if (archivePath.includes("\\")) return undefined;
  const cleaned = normalizeArchivePath(archivePath);
  const parts = cleaned.split("/");
  if (parts.length !== 3 || parts[0] !== "assets") return undefined;
  const file = parts[2] ?? "";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const format = file.slice(dot + 1) as BitmapFormat;
  const iconId = file.slice(0, dot);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(iconId)) return undefined;
  try {
    const variant =
      mediaContractVersion === 1
        ? parseLegacyResourceVariantId(parts[1] ?? "")
        : parseResourceVariantId(parts[1] ?? "");
    if (variant.format !== format) return undefined;
    return { variant, iconId };
  } catch {
    return undefined;
  }
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
  const pairs = options.requestedPairs ?? variants.flatMap((variant) =>
    iconIds.map((iconId) => ({ variantId: variant.resourceVariantId, iconId })));
  const wantedPairs = new Set(pairs.map((pair) => `${pair.variantId}\0${pair.iconId}`));
  const skipped: string[] = [];
  const chosen = new Map<string, SelectedBitmapAsset>();
  const errors: string[] = [];

  for (const [archivePath, bytes] of Object.entries(archiveFiles)) {
    const matched = matchArchiveBitmapFile(archivePath, options);
    if (!matched) continue;
    if (!wanted.has(matched.variant.resourceVariantId)) {
      skipped.push(archivePath);
      continue;
    }
    if (!iconSet.has(matched.iconId) || !wantedPairs.has(`${matched.variant.resourceVariantId}\0${matched.iconId}`)) {
      skipped.push(archivePath);
      continue;
    }
    const destRel = assetRelativePath(matched.variant.resourceVariantId, matched.iconId, matched.variant.format);
    if (chosen.has(destRel)) {
      errors.push(`duplicate bitmap asset for "${destRel}"`);
      continue;
    }
    chosen.set(destRel, {
      destRel,
      bytes,
      resourceVariantId: matched.variant.resourceVariantId,
      iconId: matched.iconId,
    });
  }

  for (const pair of pairs) {
      const variant = wanted.get(pair.variantId);
      if (!variant) continue;
      const destRel = assetRelativePath(variant.resourceVariantId, pair.iconId, variant.format);
      if (!chosen.has(destRel)) {
        errors.push(
          `bitmap asset missing for icon "${pair.iconId}" variant "${variant.resourceVariantId}"`,
        );
      }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, assets: [...chosen.values()], skipped };
}
