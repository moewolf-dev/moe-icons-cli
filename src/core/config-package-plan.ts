import { findCatalogStyleGroup, parseCatalog, type IconCatalog } from '../catalog/catalog.js';
import type { MoeiconsConfigFile } from '../project/config.js';
import { resolveIconTheme } from './icon-selection.js';
import { resolveResourceVariant } from './resource-variant.js';
import { planSelectedPackages, type SelectedCandidate } from './small-package-selection.js';
import type { PackageRow } from './small-pack/candidate-set.cjs';

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`config package plan: ${message}`); }
export function planConfigPackages(config: MoeiconsConfigFile, catalog: IconCatalog, candidate: SelectedCandidate): { resourceKeys: readonly string[]; packages: readonly PackageRow[]; fallbacks: readonly string[] } {
  check(config.icons.length > 0 && Object.keys(config.themes).length > 0, 'registered icons and themes required');
  check(config.downloadMode !== 'full', 'published package installs cannot use downloadMode=full');
  check(config.tier === candidate.root.tier, 'config tier differs from pinned candidate');
  check(catalog.sourceVersion === candidate.root.fullVersion && catalog.sourceCommit === candidate.root.sourceCommit && catalog.generatorCommit === candidate.root.generatorCommit, 'catalog differs from pinned candidate identity');
  const keys = new Set<string>(), fallbacks = new Set<string>();
  for (const iconId of config.icons) for (const requested of Object.keys(config.themes)) {
    const actual = resolveIconTheme(config, catalog, requested, iconId); check(actual, `no selected variant for ${requested}/${iconId}`);
    if (actual !== requested) fallbacks.add(`${iconId}: ${requested} -> ${actual}`);
    const theme = config.themes[actual]; check(theme, 'resolved theme missing');
    const group = findCatalogStyleGroup(theme.styleGroup, catalog); check(group && group.tiers.includes(config.tier), 'group is unavailable in selected tier');
    keys.add(`metadata/${config.tier}/${group.id}`);
    if (group.type === 'bitmap') {
      check(config.target !== 'vanilla', 'Vanilla does not support bitmap icons');
      const variant = resolveResourceVariant(group.id, { ...(theme.format ? { format: theme.format } : {}), ...(theme.imageSize ? { imageSize: theme.imageSize } : {}) });
      check(group.formats.includes(variant.format) && group.imageSizes.includes(variant.imageSize) && group.variants?.includes(variant.resourceVariantId), 'bitmap tuple is not declared by pinned catalog');
      keys.add(`bitmap/${config.tier}/${group.id}/${variant.imageSize}x${variant.imageSize}/${variant.format}`);
    } else {
      if (config.target === 'assets' || config.target === 'vanilla') keys.add(`svg/${config.tier}/${group.id}`);
      if (config.target !== 'assets') keys.add(`code/${config.tier}/${config.target}/${group.id}`);
    }
  }
  const resourceKeys = [...keys].sort();
  return { resourceKeys, packages: planSelectedPackages(candidate, resourceKeys), fallbacks: [...fallbacks].sort() };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, stable(item)]));
  return value;
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

/** Bootstrap only the scoped metadata needed by this project's themes, then
 * plan exact content units against the resulting candidate-bound catalog. The
 * loader must return bytes from the selected-package verifier. */
export async function planConfigPackagesFromMetadata(
  config: MoeiconsConfigFile,
  candidate: SelectedCandidate,
  loadVerifiedPackage: (row: PackageRow) => Promise<Readonly<Record<string, Uint8Array>>>,
): Promise<{ catalog: IconCatalog; resourceKeys: readonly string[]; packages: readonly PackageRow[]; fallbacks: readonly string[] }> {
  check(config.icons.length > 0 && Object.keys(config.themes).length > 0, 'registered icons and themes required');
  check(config.downloadMode !== 'full', 'published package installs cannot use downloadMode=full');
  check(config.tier === candidate.root.tier, 'config tier differs from pinned candidate');
  const groupIds = [...new Set(Object.values(config.themes)
    .filter(theme => theme.icons === undefined || theme.icons.some(icon => config.icons.includes(icon)))
    .map(theme => theme.styleGroup))].sort();
  check(groupIds.length > 0, 'configured themes required');
  const groups = new Map<string, unknown>();
  const icons = new Map<string, Record<string, unknown>>();
  for (const groupId of groupIds) {
    const row = candidate.rows.find(item => item.resourceKey === `metadata/${config.tier}/${groupId}`);
    check(row && row.kind === 'metadata' && row.styleGroupId === groupId && row.tier === config.tier, `scoped metadata missing for ${groupId}`);
    const files = await loadVerifiedPackage(row);
    const bytes = files['metadata/catalog.json']; check(bytes, `scoped catalog missing for ${groupId}`);
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error(`config package plan: invalid scoped catalog for ${groupId}`); }
    check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `scoped catalog object required for ${groupId}`);
    const scoped = raw as Record<string, unknown>;
    check(Object.keys(scoped).sort().join(',') === 'icons,schemaVersion,styleGroups' && scoped.schemaVersion === 1 && Array.isArray(scoped.styleGroups) && scoped.styleGroups.length === 1 && Array.isArray(scoped.icons), `scoped catalog schema/scope invalid for ${groupId}`);
    const group = scoped.styleGroups[0] as Record<string, unknown>;
    check(group && group.id === groupId && !groups.has(groupId), `scoped style group differs for ${groupId}`);
    groups.set(groupId, group);
    check(scoped.icons.length > 0, `scoped catalog has no icons for ${groupId}`);
    for (const value of scoped.icons) {
      check(value !== null && typeof value === 'object' && !Array.isArray(value), `invalid scoped icon in ${groupId}`);
      const icon = value as Record<string, unknown>;
      check(typeof icon.id === 'string' && Array.isArray(icon.availableIn) && icon.availableIn.length === 1 && icon.availableIn[0] === groupId, `scoped icon crosses group boundary in ${groupId}`);
      if (icon.variants !== undefined) check(stringArray(icon.variants), `invalid scoped icon variants in ${groupId}`);
      const previous = icons.get(icon.id);
      if (!previous) { icons.set(icon.id, { ...icon, availableIn: [groupId], ...(stringArray(icon.variants) ? { variants: [...icon.variants] } : {}) }); continue; }
      const stripScope = (entry: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'availableIn' && key !== 'variants'));
      check(JSON.stringify(stable(stripScope(previous))) === JSON.stringify(stable(stripScope(icon))), `icon metadata conflicts across scoped catalogs: ${icon.id}`);
      previous.availableIn = [...new Set([...(previous.availableIn as string[]), groupId])].sort();
      if (stringArray(icon.variants)) previous.variants = [...new Set([...(stringArray(previous.variants) ? previous.variants : []), ...icon.variants])].sort();
    }
  }
  const catalog = parseCatalog({
    schemaVersion: 1,
    catalogVersion: candidate.root.fullVersion,
    sourceVersion: candidate.root.fullVersion,
    sourceCommit: candidate.root.sourceCommit,
    generatorCommit: candidate.root.generatorCommit,
    styleGroups: [...groups.values()],
    icons: [...icons.values()],
  });
  return { catalog, ...planConfigPackages(config, catalog, candidate) };
}
export interface PackageTargetFiles { readonly area: 'target' | 'assets' | 'metadata'; readonly files: Readonly<Record<string, Uint8Array>> }
/** Map one already verified unit; never accumulate multiple packages or invent
 * an all-tier archive identity. Callers stage these files transactionally. */
export function packageTargetFiles(row: PackageRow, files: Readonly<Record<string, Uint8Array>>, target: MoeiconsConfigFile['target']): PackageTargetFiles {
  check(Object.hasOwn(files, 'manifest.json'), 'verified unit manifest required');
  const output: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let area: PackageTargetFiles['area'];
  if (row.kind === 'code' || row.kind === 'shared') { check(row.target === target, `package target mismatch for ${row.resourceKey}: expected ${target}, received ${row.target}`); area = 'target'; }
  else if (row.kind === 'svg' || row.kind === 'bitmap') { check(row.kind !== 'svg' || target === 'assets' || target === 'vanilla', 'raw SVG unit is not required by compiled target'); check(target !== 'vanilla' || row.kind !== 'bitmap', 'Vanilla bitmap unsupported'); area = 'assets'; }
  else { check(row.kind === 'metadata', 'unsupported installation package kind'); area = 'metadata'; }
  for (const [name, bytes] of Object.entries(files)) {
    if (name === 'manifest.json') continue;
    check(!/[\\:]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe unit path');
    let destination: string;
    if (row.kind === 'shared') destination = name;
    else if (row.kind === 'code' || row.kind === 'svg') { check(row.styleGroupId, 'group scope missing'); destination = `${row.styleGroupId}/${name}`; }
    else if (row.kind === 'metadata') { check(row.styleGroupId && name.startsWith('metadata/'), 'metadata scope missing'); destination = `${row.styleGroupId}/${name.slice(9)}`; }
    else {
      check(row.styleGroupId && row.variant && name.startsWith('icons/'), 'bitmap tuple scope missing');
      const variant = resolveResourceVariant(row.styleGroupId, { format: row.variant.format, imageSize: row.variant.width });
      destination = `${variant.resourceVariantId}/${name.slice(6)}`;
    }
    check(!Object.hasOwn(output, destination), 'duplicate target file'); output[destination] = bytes;
  }
  check(Object.keys(output).length > 0, 'empty installation unit'); return { area, files: output };
}
