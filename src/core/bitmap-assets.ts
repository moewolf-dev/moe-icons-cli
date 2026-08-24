import { parseResourceVariantId, assetRelativePath, type ResourceVariant } from "./resource-variant.js";

export interface SelectedBitmapAsset {
  /** POSIX path relative to outputDir, e.g. assets/moe-cute-3d-webp-256/ui-search.webp */
  readonly destRel: string;
  readonly bytes: Uint8Array;
  readonly resourceVariantId: string;
  readonly iconId: string;
}

function normalizeArchivePath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Identify a bitmap file inside a free/pro archive by parsing a directory
 * segment as resourceVariantId (G2, from the right). Never scans for a mid-path `-3d`.
 */
export function matchArchiveBitmapFile(
  archivePath: string,
): { readonly variant: ResourceVariant; readonly iconId: string } | undefined {
  const cleaned = normalizeArchivePath(archivePath);
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const file = parts[parts.length - 1] ?? "";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const format = file.slice(dot + 1);
  const iconId = file.slice(0, dot);
  if (!iconId || iconId.includes("..")) return undefined;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i] ?? "";
    try {
      const variant = parseResourceVariantId(segment);
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
): SelectBitmapAssetsResult {
  const wanted = new Map(variants.map((variant) => [variant.resourceVariantId, variant]));
  const iconSet = new Set(iconIds);
  const skipped: string[] = [];
  const chosen = new Map<string, SelectedBitmapAsset>();

  for (const [archivePath, bytes] of Object.entries(archiveFiles)) {
    const matched = matchArchiveBitmapFile(archivePath);
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
