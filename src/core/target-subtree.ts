import { createHash } from "node:crypto";
import { extractTarGz, ICON_ARCHIVE_MAX_ENTRIES, ICON_ARCHIVE_MAX_EXPANDED_BYTES } from "../project/tar-gz.js";
import type { ReleaseTarget, ReleaseTargetMetadata } from "./release-descriptor.js";
import type { Target } from "../commands/parser.js";
import { posix } from "node:path";
import { toProxyName } from "./icon-names.js";
import type { MoeiconsConfigFile } from "../project/config.js";
import { findCatalogStyleGroup, type IconCatalog } from "../catalog/catalog.js";
import { resolveIconTheme } from "./icon-selection.js";

/**
 * Select the target subtree the CLI must install. Mirrors the archive layout
 * frozen in the code-library contract: each tier archive contains
 * `react/`, `vue/`, `vanilla/` and `assets/` subtrees and the CLI installs only
 * the selected one. When the source carries per-target subtree metadata
 * (`targetMetadata[target] = { path, sha256, fileCount, byteCount }`) the
 * subtree hash/size is verified against the downloaded archive bytes.
 */

export interface TargetSubtreeSource {
  readonly targets?: readonly ReleaseTarget[];
  readonly targetMetadata?: Readonly<Partial<Record<ReleaseTarget, ReleaseTargetMetadata>>>;
}

export interface TargetSubtreeSelection {
  readonly ok: true;
  readonly target: Target;
  /** Subtree-relative file map (e.g. `moe-outline/foo.svg` for the assets subtree). */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly sha256: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

export type TargetSubtreeFailure = {
  readonly ok: false;
  readonly reason: "validation" | "checksum-mismatch";
  readonly message: string;
};

export type TargetSubtreeResult = TargetSubtreeSelection | TargetSubtreeFailure;

/** Keep only the component modules reachable from configured icon proxies.
 * The full target subtree must be verified against its release descriptor
 * before this projection is called; this is a local installation filter, not
 * a replacement for the immutable archive digest.
 */
export function configuredComponentFiles(
  files: Readonly<Record<string, Uint8Array>>,
  target: Target,
  config: MoeiconsConfigFile | undefined,
  catalog: IconCatalog,
): Readonly<Record<string, Uint8Array>> {
  if (!config || (target !== "react" && target !== "vue")) return files;
  const selected = new Set<string>();
  const visit = (file: string): void => {
    if (selected.has(file)) return;
    const bytes = files[file];
    if (!bytes) throw new Error(`verified ${target} archive is missing configured module: ${file}`);
    selected.add(file);
    const source = Buffer.from(bytes).toString("utf8");
    const imports = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\()\s*["'](\.[^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1];
      if (!specifier) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (resolved.startsWith("../") || resolved === "..") throw new Error(`component import escapes target: ${file} → ${specifier}`);
      const dependency = files[resolved] ? resolved : files[`${resolved}.d.ts`] ? `${resolved}.d.ts` : undefined;
      if (!dependency) throw new Error(`verified ${target} archive is missing dependency: ${file} → ${specifier}`);
      visit(dependency);
    }
  };
  visit("types.d.ts");
  for (const iconId of config.icons) {
    for (const theme of Object.keys(config.themes)) {
      const actual = resolveIconTheme(config, catalog, theme, iconId);
      if (!actual) throw new Error(`icon "${iconId}" has no selected variant for theme "${theme}"`);
      const group = config.themes[actual]!.styleGroup;
      if (findCatalogStyleGroup(group, catalog)?.type === "bitmap") continue;
      const basename = `${group}/${toProxyName(iconId)}${target === "vue" ? ".vue" : ""}`;
      visit(`${basename}.js`);
      visit(`${basename}.d.ts`);
    }
  }
  return Object.fromEntries([...selected].sort().map((file) => [file, files[file]!]));
}

/**
 * Deterministic subtree hash over subtree-relative files. Files and directories
 * are visited depth-first sorted by `localeCompare`, and each file contributes
 * `<relative>\0<bytes>\0` — the same algorithm used by the code-library release
 * packer (`subtreeHash` in scripts/pack-release-artifacts.cjs).
 */
export function computeSubtreeHash(
  files: Readonly<Record<string, Uint8Array>>,
): { readonly sha256: string; readonly fileCount: number; readonly byteCount: number } {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  const namesAt = (prefix: string): string[] => {
    const names = new Set<string>();
    for (const rel of Object.keys(files)) {
      if (!prefix || rel.startsWith(`${prefix}/`)) {
        const rest = prefix ? rel.slice(prefix.length + 1) : rel;
        const slash = rest.indexOf("/");
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  };
  const walk = (prefix: string): void => {
    for (const name of namesAt(prefix)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const bytes = files[rel];
      if (bytes) {
        hash.update(rel).update("\0").update(bytes).update("\0");
        fileCount += 1;
        byteCount += bytes.byteLength;
      } else {
        walk(rel);
      }
    }
  };
  walk("");
  return { sha256: hash.digest("hex"), fileCount, byteCount };
}

function subtreeFilesOf(
  extracted: Readonly<Record<string, Uint8Array>>,
  target: Target,
): Record<string, Uint8Array> {
  const prefix = `${target}/`;
  const files: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(extracted)) {
    if (path === target || path.startsWith(prefix)) {
      files[path.slice(prefix.length)] = bytes;
    }
  }
  return files;
}

function hasModernTargetContract(source: TargetSubtreeSource): boolean {
  if (source.targets !== undefined && source.targets.length > 0) return true;
  if (source.targetMetadata !== undefined && Object.keys(source.targetMetadata).length > 0) return true;
  return false;
}

/**
 * Extract and verify the selected target's subtree from an archive.
 *
 * Modern descriptors (those that declare `targets` and/or `targetMetadata`)
 * must include the selected target, provide matching metadata, and yield a
 * non-empty subtree. Legacy `{ filename, sha256 }` descriptors skip hash
 * verification for backward compatibility but still reject an empty subtree.
 */
export function selectTargetSubtree(
  archiveBytes: Uint8Array,
  source: TargetSubtreeSource,
  target: Target,
): TargetSubtreeResult {
  const extracted = extractTarGz(archiveBytes, {
    maxEntries: ICON_ARCHIVE_MAX_ENTRIES,
    maxExpandedBytes: ICON_ARCHIVE_MAX_EXPANDED_BYTES,
  });
  if (extracted.errors.length > 0) {
    return { ok: false, reason: "validation", message: extracted.errors[0] ?? "invalid archive" };
  }
  const files = subtreeFilesOf(extracted.files, target);
  const computed = computeSubtreeHash(files);
  const modern = hasModernTargetContract(source);

  if (modern) {
    if (source.targets !== undefined && !source.targets.includes(target)) {
      return {
        ok: false,
        reason: "validation",
        message: `descriptor does not declare target "${target}"`,
      };
    }
    const expected = source.targetMetadata?.[target];
    if (!expected) {
      return {
        ok: false,
        reason: "validation",
        message: `descriptor is missing targetMetadata for "${target}"`,
      };
    }
    const normalizedPath = expected.path.replace(/\/$/, "");
    if (normalizedPath !== target) {
      return {
        ok: false,
        reason: "validation",
        message: `targetMetadata["${target}"].path must be "${target}" (got "${expected.path}")`,
      };
    }
  }

  if (computed.fileCount === 0) {
    return {
      ok: false,
      reason: "validation",
      message: `target subtree "${target}" is empty or missing from the archive`,
    };
  }

  if (modern) {
    const expected = source.targetMetadata?.[target];
    if (
      expected &&
      (computed.sha256 !== expected.sha256 ||
        computed.fileCount !== expected.fileCount ||
        computed.byteCount !== expected.byteCount)
    ) {
      return {
        ok: false,
        reason: "checksum-mismatch",
        message:
          `target subtree "${target}" mismatch: ` +
          `expected sha256=${expected.sha256} files=${expected.fileCount} bytes=${expected.byteCount}, ` +
          `got sha256=${computed.sha256} files=${computed.fileCount} bytes=${computed.byteCount}`,
      };
    }
  }

  return {
    ok: true,
    target,
    files,
    sha256: computed.sha256,
    fileCount: computed.fileCount,
    byteCount: computed.byteCount,
  };
}
