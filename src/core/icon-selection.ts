import { findCatalogIcon, type IconCatalog } from "../catalog/catalog.js";
import type { MoeiconsConfigFile } from "../project/config.js";

/** A theme owns a variant only when it is selected and shipped by the catalog. */
export function themeHasIcon(config: MoeiconsConfigFile, catalog: IconCatalog, theme: string, iconId: string): boolean {
  const entry = config.themes[theme];
  return Boolean(entry && config.icons.includes(iconId) &&
    (entry.icons === undefined || entry.icons.includes(iconId)) &&
    findCatalogIcon(iconId, catalog)?.availableIn.includes(entry.styleGroup));
}

/** Stable fallback: requested theme, default theme, then theme keys in ASCII order.
 * Unregistered icons and an empty configured variant set never resolve.
 */
export function resolveIconTheme(config: MoeiconsConfigFile, catalog: IconCatalog, requested: string, iconId: string): string | undefined {
  if (themeHasIcon(config, catalog, requested, iconId)) return requested;
  if (config.missingIconPolicy !== "fallback") return undefined;
  const candidates = [config.defaultTheme, ...Object.keys(config.themes).sort()];
  return candidates.find((theme) => themeHasIcon(config, catalog, theme, iconId));
}
