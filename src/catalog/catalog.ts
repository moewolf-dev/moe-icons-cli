import bundledCatalog from "./catalog.json" with { type: "json" };
import { parseResourceVariantId } from "../core/resource-variant.js";

export type CatalogStyleGroupType = "outline" | "solid" | "mixed" | "bitmap";
export type CatalogTier = "free" | "pro";
export type CatalogFormat = "svg" | "webp" | "png";

export interface CatalogStyleGroup {
  readonly id: string;
  readonly type: CatalogStyleGroupType;
  readonly tiers: readonly CatalogTier[];
  readonly formats: readonly CatalogFormat[];
  readonly imageSizes: readonly number[];
  /**
   * MEDIA-FORMAT-V2: canonical bitmap resourceVariantIds declared by the
   * catalog. This is the exact availability authority; a format/size pair that
   * is not in this list must fail even when it is inside `formats`/`imageSizes`.
   */
  readonly variants?: readonly string[];
}

export interface CatalogIcon {
  readonly id: string;
  readonly name?: string;
  readonly prefix: string;
  readonly label: string;
  readonly keywords?: readonly string[];
  readonly categories?: readonly string[];
  readonly variants?: readonly string[];
  readonly targets?: readonly string[];
  readonly aliases: readonly string[];
  readonly deprecatedAt?: string;
  readonly replacedBy?: string;
  readonly availableIn: readonly string[];
}

export interface IconCatalog {
  readonly schemaVersion: 1;
  readonly catalogVersion: string;
  readonly sourceVersion: string;
  readonly sourceCommit: string;
  readonly generatorCommit: string;
  readonly styleGroups: readonly CatalogStyleGroup[];
  readonly icons: readonly CatalogIcon[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseCatalog(value: unknown): IconCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("unsupported catalog schema; reinstall a compatible moeicons package");
  }
  for (const field of ["catalogVersion", "sourceVersion", "sourceCommit", "generatorCommit"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`catalog field ${field} must be a non-empty string`);
    }
  }
  const catalogVersion = value.catalogVersion as string;
  const sourceVersion = value.sourceVersion as string;
  const sourceCommit = value.sourceCommit as string;
  const generatorCommit = value.generatorCommit as string;
  if (!Array.isArray(value.styleGroups) || !Array.isArray(value.icons)) {
    throw new Error("catalog styleGroups and icons must be arrays");
  }
  const groups = value.styleGroups.map((group): CatalogStyleGroup => {
    if (!isRecord(group) || typeof group.id !== "string" || typeof group.type !== "string") {
      throw new Error("catalog style group is invalid");
    }
    if (!isStringArray(group.tiers) || !group.tiers.every((tier) => tier === "free" || tier === "pro")) {
      throw new Error(`catalog style group ${group.id} has invalid tiers`);
    }
    if (!isStringArray(group.formats) || !group.formats.every((format) => ["svg", "webp", "png"].includes(format))) {
      throw new Error(`catalog style group ${group.id} has invalid formats`);
    }
    if (!Array.isArray(group.imageSizes) || !group.imageSizes.every((size) => typeof size === "number")) {
      throw new Error(`catalog style group ${group.id} has invalid imageSizes`);
    }
    if (!["outline", "solid", "mixed", "bitmap"].includes(group.type)) {
      throw new Error(`catalog style group ${group.id} has invalid type`);
    }
    if (group.variants !== undefined && !isStringArray(group.variants)) {
      throw new Error(`catalog style group ${group.id} has invalid variants`);
    }
    const groupVariants = group.variants;
    if (groupVariants && (groupVariants.length === 0 || new Set(groupVariants).size !== groupVariants.length)) {
      throw new Error(`catalog style group ${group.id} has empty or duplicate variants`);
    }
    if (group.type !== "bitmap" && groupVariants !== undefined) {
      throw new Error(`catalog SVG style group ${group.id} must not declare bitmap variants`);
    }
    if (group.type === "bitmap" && groupVariants) {
      for (const variantId of groupVariants) {
        let variant;
        try {
          variant = parseResourceVariantId(variantId);
        } catch {
          throw new Error(`catalog style group ${group.id} has inconsistent variant ${variantId}`);
        }
        if (variant.styleGroupId !== group.id || !group.formats.includes(variant.format)
          || !group.imageSizes.includes(variant.imageSize)) {
          throw new Error(`catalog style group ${group.id} has inconsistent variant ${variantId}`);
        }
      }
    }
    return {
      id: group.id,
      type: group.type as CatalogStyleGroupType,
      tiers: group.tiers as readonly CatalogTier[],
      formats: group.formats as readonly CatalogFormat[],
      imageSizes: group.imageSizes,
      ...(groupVariants ? { variants: groupVariants } : {}),
    };
  });
  const groupIds = new Set(groups.map((group) => group.id));
  const icons = value.icons.map((icon): CatalogIcon => {
    if (!isRecord(icon) || typeof icon.id !== "string" || typeof icon.prefix !== "string" || typeof icon.label !== "string") {
      throw new Error("catalog icon is invalid");
    }
    if (!isStringArray(icon.aliases) || !isStringArray(icon.availableIn) || !icon.availableIn.every((id) => groupIds.has(id))) {
      throw new Error(`catalog icon ${icon.id} has invalid availability`);
    }
    const stringArray = (field: unknown, name: string): readonly string[] | undefined => {
      if (field === undefined) return undefined;
      if (!isStringArray(field)) throw new Error(`catalog icon ${String(icon.id)} has invalid ${name}`);
      return field;
    };
    const keywords = stringArray(icon.keywords, "keywords");
    const categories = stringArray(icon.categories, "categories");
    const variants = stringArray(icon.variants, "variants");
    const targets = stringArray(icon.targets, "targets");
    return {
      id: icon.id,
      ...(typeof icon.name === "string" ? { name: icon.name } : {}),
      prefix: icon.prefix,
      label: icon.label,
      ...(keywords ? { keywords } : {}),
      ...(categories ? { categories } : {}),
      ...(variants ? { variants } : {}),
      ...(targets ? { targets } : {}),
      aliases: icon.aliases,
      ...(typeof icon.deprecatedAt === "string" ? { deprecatedAt: icon.deprecatedAt } : {}),
      ...(typeof icon.replacedBy === "string" ? { replacedBy: icon.replacedBy } : {}),
      availableIn: icon.availableIn,
    };
  });
  return {
    schemaVersion: 1,
    catalogVersion,
    sourceVersion,
    sourceCommit,
    generatorCommit,
    styleGroups: groups,
    icons,
  };
}

export const catalog: IconCatalog = parseCatalog(bundledCatalog);

export function findCatalogStyleGroup(id: string, source: IconCatalog = catalog): CatalogStyleGroup | undefined {
  return source.styleGroups.find((group) => group.id === id);
}

export function findCatalogIcon(id: string, source: IconCatalog = catalog): CatalogIcon | undefined {
  return source.icons.find((icon) => icon.id === id);
}
