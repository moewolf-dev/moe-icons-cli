import { catalog, findCatalogStyleGroup, type CatalogStyleGroup, type IconCatalog } from "../catalog/catalog.js";
import type { MoeiconsConfigFile, MoeiconsThemeConfig } from "../project/config.js";
import {
  assetRelativePath,
  buildResourceVariantId,
  DEFAULT_BITMAP_FORMAT,
  DEFAULT_BITMAP_SIZE,
  resolveResourceVariant,
  type ResourceVariant,
} from "../core/resource-variant.js";
import { toLibraryExportName, toProxyName } from "../core/icon-names.js";

export type ThemeKind = "svg" | "bitmap";

export interface ResolvedTheme {
  readonly theme: string;
  readonly entry: MoeiconsThemeConfig;
  readonly kind: ThemeKind;
  readonly group: CatalogStyleGroup;
  readonly variant?: ResourceVariant;
}

/** Exact availability check: catalog `variants` is authoritative when present. */
export function isVariantAvailable(group: CatalogStyleGroup, resourceVariantId: string): boolean {
  if (group.variants && group.variants.length > 0) return group.variants.includes(resourceVariantId);
  const parts = resourceVariantId.split("-");
  const format = parts[parts.length - 1];
  const imageSize = Number(parts[parts.length - 2]);
  return group.formats.includes(format as "svg" | "webp" | "png") && group.imageSizes.includes(imageSize);
}

export function resolveThemes(config: MoeiconsConfigFile, sourceCatalog: IconCatalog = catalog): { readonly ok: true; readonly themes: ResolvedTheme[] } | { readonly ok: false; readonly errors: string[] } {
  const errors: string[] = [];
  const themes: ResolvedTheme[] = [];
  for (const [theme, entry] of Object.entries(config.themes)) {
    const group = findCatalogStyleGroup(entry.styleGroup, sourceCatalog);
    if (!group) {
      errors.push(`unknown style group "${entry.styleGroup}" for theme "${theme}"`);
      continue;
    }
    if (group.type === "bitmap") {
      try {
        let variant: ResourceVariant;
        if (entry.format === undefined && entry.imageSize === undefined) {
          // B6: the default is only usable when the group truly declares it.
          const defaultId = buildResourceVariantId(group.id, DEFAULT_BITMAP_FORMAT, DEFAULT_BITMAP_SIZE);
          if (!isVariantAvailable(group, defaultId)) {
            errors.push(
              `bitmap group "${group.id}" does not include the default ${DEFAULT_BITMAP_FORMAT}/${String(DEFAULT_BITMAP_SIZE)} variant; set format and imageSize explicitly`,
            );
            continue;
          }
          variant = resolveResourceVariant(group.id);
        } else {
          variant = resolveResourceVariant(group.id, {
            ...(entry.format !== undefined ? { format: entry.format } : {}),
            ...(entry.imageSize !== undefined ? { imageSize: entry.imageSize } : {}),
          });
        }
        if (!isVariantAvailable(group, variant.resourceVariantId)) {
          errors.push(`variant ${variant.resourceVariantId} is unavailable for ${group.id}`);
          continue;
        }
        themes.push({ theme, entry, kind: "bitmap", group, variant });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      themes.push({ theme, entry, kind: "svg", group });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, themes };
}

export function bitmapWrapperImportName(theme: string, iconId: string): string {
  return `${toProxyName(theme)}${toProxyName(iconId)}Bitmap`;
}

export function svgInternalImportName(theme: string, styleGroup: string, iconId: string): string {
  return `${toProxyName(theme)}${toProxyName(styleGroup)}${toProxyName(iconId)}`;
}

/** Relative import from icons/Foo.tsx → assets/... */
export function relativeAssetImportFromIcons(variant: ResourceVariant, iconId: string): string {
  return `../${assetRelativePath(variant.resourceVariantId, iconId, variant.format)}`;
}

export function reactBitmapWrapperSource(
  iconId: string,
  wrapperName: string,
  variant: ResourceVariant,
  themeClassName: string | undefined,
): string {
  const assetImport = relativeAssetImportFromIcons(variant, iconId);
  const defaultClass = themeClassName ? JSON.stringify(themeClassName) : "undefined";
  return `import type { IconProps } from "../types";
import { cn } from "../cn";
import assetUrl from "${assetImport}";

export function ${wrapperName}(props: IconProps) {
  const { className, size, "aria-label": ariaLabel, strokeWidth: _strokeWidth, ...rest } = props;
  const sizeClass = typeof size === "number" ? \`w-[\${size}px] h-[\${size}px]\` : undefined;
  return (
    <img
      src={assetUrl}
      alt={ariaLabel ?? ""}
      aria-hidden={ariaLabel ? undefined : true}
      draggable={false}
      className={cn("moe-icon", ${defaultClass}, sizeClass, className)}
      {...rest}
    />
  );
}
`;
}

export function vueBitmapWrapperSource(
  iconId: string,
  wrapperName: string,
  variant: ResourceVariant,
  themeClassName: string | undefined,
): string {
  const assetImport = relativeAssetImportFromIcons(variant, iconId);
  const defaultClass = themeClassName ? JSON.stringify(themeClassName) : "undefined";
  return `import { defineComponent, h } from "vue";
import { cn } from "../cn";
import assetUrl from "${assetImport}";

export const ${wrapperName} = defineComponent({
  name: "${wrapperName}",
  setup(_props, { attrs }) {
    return () => {
      const className = typeof attrs.class === "string" ? attrs.class : undefined;
      const size = typeof attrs.size === "number" ? attrs.size : undefined;
      const ariaLabel = typeof attrs["aria-label"] === "string" ? attrs["aria-label"] : undefined;
      const sizeClass = typeof size === "number" ? \`w-[\${size}px] h-[\${size}px]\` : undefined;
      return h("img", {
        ...attrs,
        src: assetUrl,
        alt: ariaLabel ?? "",
        "aria-hidden": ariaLabel ? undefined : true,
        draggable: false,
        class: cn("moe-icon", ${defaultClass}, sizeClass, className),
      });
    };
  },
});
`;
}

export { toLibraryExportName, toProxyName };
