/**
 * Canonical iconId → public name mapping.
 *
 * Must stay equivalent to moe-icons-code-library `scripts/generator-core.cjs`
 * (`toComponentName` / `toExportName` / `reportNameCollisions`). The library
 * keeps camelCase exports; CLI proxies keep PascalCase. Registry imports use
 * an explicit alias between the two.
 */

const RESERVED_IDENTIFIERS =
  /^(?:default|class|function|var|let|const|new|return|delete|import|export)$/;

function nameSegments(value: string): string[] {
  return String(value)
    .normalize("NFKD")
    .split("")
    .filter((character) => character.charCodeAt(0) <= 0x7f)
    .join("")
    .split("-")
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9_$]/g, ""));
}

/** Library/file/proxy PascalCase: `ui-search` → `UiSearch`. */
export function toProxyName(iconId: string): string {
  const segments = nameSegments(iconId);
  let result =
    segments.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join("") || "Icon";
  if (/^[0-9]/.test(result) || RESERVED_IDENTIFIERS.test(result.toLowerCase())) {
    result = `Icon${result}`;
  }
  return result;
}

/** Published library camelCase export: `ui-search` → `uiSearch`. */
export function toLibraryExportName(iconId: string): string {
  const component = toProxyName(iconId);
  return component.charAt(0).toLowerCase() + component.slice(1);
}

export function reportProxyNameCollisions(iconIds: readonly string[]): string[] {
  return reportCollisions(iconIds, toProxyName, "PascalCase");
}

export function reportLibraryExportNameCollisions(iconIds: readonly string[]): string[] {
  return reportCollisions(iconIds, toLibraryExportName, "library export");
}

function reportCollisions(
  iconIds: readonly string[],
  nameOf: (id: string) => string,
  kind: string,
): string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const id of iconIds) {
    const name = nameOf(id);
    const existing = seen.get(name);
    if (existing) {
      collisions.push(`duplicate ${kind} name "${name}" from "${existing}" and "${id}"`);
    } else {
      seen.set(name, id);
    }
  }
  return collisions;
}
