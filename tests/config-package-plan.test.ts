import { it, expect } from 'vitest';
import fs from 'node:fs';
import { planConfigPackages, planConfigPackagesFromMetadata, packageTargetFiles } from '../src/core/config-package-plan.js';
import { buildCandidateSet, canonicalBytes, sha256, type PackageRow } from '../src/core/small-pack/candidate-set.cjs';
import { readSelectedCandidate, verifySelectedPackage } from '../src/core/small-package-selection.js';
import type { IconCatalog } from '../src/catalog/catalog.js';
import type { MoeiconsConfigFile } from '../src/project/config.js';
function row(kind: PackageRow['kind'], tier: 'free' | 'pro', group?: string, target?: string, variant?: PackageRow['variant']): PackageRow {
  const scope = { kind, tier, ...(group ? { styleGroupId: group } : {}), ...(target ? { target } : {}), ...(variant ? { variant } : {}) };
  const digest = sha256(canonicalBytes(scope));
  const resourceKey = kind === 'shared' ? `shared/${tier}/${target}` : kind === 'code' ? `code/${tier}/${target}/${group}` : kind === 'bitmap' ? `bitmap/${tier}/${group}/${variant!.width}x${variant!.height}/${variant!.format}` : `${kind}/${tier}/${group}`;
  return { ...scope, resourceKey, packageSha256: digest, filename: `packages/${digest}.tgz`, fullVersion: '1.0.0', compressedBytes: 10, expandedBytes: 100, fileCount: 2, dependencies: [] };
}
async function fixture(tier: 'free' | 'pro' = 'pro') {
  const rows: PackageRow[] = [];
  for (const group of ['moe-outline', 'moe-solid']) {
    rows.push(row('metadata', tier, group), row('svg', tier, group));
    for (const target of ['react', 'vue', 'vanilla']) rows.push(row('code', tier, group, target));
  }
  for (const target of ['react', 'vue', 'vanilla']) { const shared = row('shared', tier, undefined, target); rows.push(shared); for (const code of rows.filter(r => r.kind === 'code' && r.target === target)) code.dependencies.push(shared.packageSha256); }
  rows.push(row('metadata', tier, 'moe-blue'));
  for (const size of [128, 256, 512]) for (const format of ['png', 'webp']) rows.push(row('bitmap', tier, 'moe-blue', undefined, { width: size, height: size, format }));
  const built = buildCandidateSet({ fullVersion: '1.0.0', tier, sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packages: rows });
  const candidate = await readSelectedCandidate(built.rootBytes, built.candidateSet, ref => Promise.resolve(built.pageBytesByName.get(ref.filename)!));
  const catalog: IconCatalog = { schemaVersion: 1, catalogVersion: '1.0.0', sourceVersion: '1.0.0', sourceCommit: built.candidateSet.sourceCommit, generatorCommit: built.candidateSet.generatorCommit, styleGroups: [
    ...['moe-outline', 'moe-solid'].map(id => ({ id, type: 'outline' as const, tiers: ['free' as const, 'pro' as const], formats: ['svg' as const], imageSizes: [] })),
    { id: 'moe-blue', type: 'bitmap', tiers: ['pro'], formats: ['png', 'webp'], imageSizes: [128, 256, 512], variants: [128, 256, 512].flatMap(size => ['png','webp'].map(format => `moe-blue-${size}-${format}`)) },
  ], icons: [{ id: 'sample', prefix: 'sample-', label: 'sample', aliases: [], availableIn: ['moe-outline', 'moe-solid', 'moe-blue'] }] };
  const config: MoeiconsConfigFile = { schemaVersion: 3, tier, target: 'react', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline', themes: { outline: { styleGroup: 'moe-outline' } } };
  return { rows, candidate, catalog, config };
}
it('compiled targets select code and shared units while Vanilla selects only its raw SVG source and metadata', async () => {
  const f = await fixture();
  for (const target of ['react', 'vue'] as const) {
    const plan = planConfigPackages({ ...f.config, target }, f.catalog, f.candidate);
    expect(plan.resourceKeys).toEqual([`code/pro/${target}/moe-outline`, 'metadata/pro/moe-outline']);
    expect(plan.packages.map(r => r.kind).sort()).toEqual(['code','metadata','shared']);
    expect(plan.packages.some(r => r.kind === 'svg' || r.styleGroupId === 'moe-solid')).toBe(false);
  }
  const vanilla = planConfigPackages({ ...f.config, target: 'vanilla' }, f.catalog, f.candidate);
  expect(vanilla.resourceKeys).toEqual(['code/pro/vanilla/moe-outline', 'metadata/pro/moe-outline', 'svg/pro/moe-outline']);
  expect(vanilla.packages.map(r => r.kind).sort()).toEqual(['code', 'metadata', 'shared', 'svg']);
  expect(vanilla.packages.some(r => r.styleGroupId === 'moe-solid')).toBe(false);
});
it('assets choose one SVG group; bitmap themes select only exact configured format/size plus metadata', async () => {
  const f = await fixture(); expect(planConfigPackages({ ...f.config, target: 'assets' }, f.catalog, f.candidate).resourceKeys).toEqual(['metadata/pro/moe-outline', 'svg/pro/moe-outline']);
  const config = { ...f.config, themes: { blue: { styleGroup: 'moe-blue', format: 'webp' as const, imageSize: 256 as const } }, defaultTheme: 'blue' };
  expect(planConfigPackages(config, f.catalog, f.candidate).resourceKeys).toEqual(['bitmap/pro/moe-blue/256x256/webp', 'metadata/pro/moe-blue']);
  expect(() => planConfigPackages({ ...config, target: 'vanilla' }, f.catalog, f.candidate)).toThrow('Vanilla');
  const catalog = { ...f.catalog, styleGroups: f.catalog.styleGroups.map(g => g.id === 'moe-blue' ? { ...g, variants: ['moe-blue-128-png'] } : g) };
  expect(() => planConfigPackages(config, catalog, f.candidate)).toThrow('not declared');
});
it('theme fallback uses existing icon selection policy; empty variant themes do not add a resource unit', async () => {
  const f = await fixture(); const config = { ...f.config, missingIconPolicy: 'fallback' as const, themes: { ...f.config.themes, empty: { styleGroup: 'moe-solid', icons: [] } } };
  const plan = planConfigPackages(config, f.catalog, f.candidate); expect(plan.fallbacks).toEqual(['sample: empty -> outline']); expect(plan.packages.some(r => r.styleGroupId === 'moe-solid')).toBe(false);
  expect(() => planConfigPackages({ ...config, missingIconPolicy: 'error' }, f.catalog, f.candidate)).toThrow('no selected variant');
});
it('bootstraps a pinned catalog from only configured scoped metadata before planning the package closure', async () => {
  const f = await fixture(); const config = { ...f.config, missingIconPolicy: 'fallback' as const, themes: { ...f.config.themes, empty: { styleGroup: 'moe-solid', icons: [] } } };
  const loaded: string[] = [];
  const planned = await planConfigPackagesFromMetadata(config, f.candidate, row => {
    loaded.push(row.resourceKey); const group = f.catalog.styleGroups.find(item => item.id === row.styleGroupId)!;
    const icon = f.catalog.icons.map(item => ({ ...item, availableIn: [row.styleGroupId!], ...(item.variants ? { variants: [row.styleGroupId!] } : {}) }));
    return Promise.resolve({ 'manifest.json': Buffer.from('{}'), 'metadata/catalog.json': Buffer.from(JSON.stringify({ schemaVersion: 1, styleGroups: [group], icons: icon })) });
  });
  expect(loaded).toEqual(['metadata/pro/moe-outline']);
  expect(planned.catalog.sourceCommit).toBe(f.candidate.root.sourceCommit);
  expect(planned.fallbacks).toEqual(['sample: empty -> outline']);
  expect(planned.resourceKeys).toEqual(['code/pro/react/moe-outline', 'metadata/pro/moe-outline']);
  expect(planned.packages.map(item => item.kind).sort()).toEqual(['code', 'metadata', 'shared']);
});
it('rejects scoped metadata that declares another style group before resource planning', async () => {
  const f = await fixture();
  await expect(planConfigPackagesFromMetadata(f.config, f.candidate, () => Promise.resolve({
    'manifest.json': Buffer.from('{}'),
    'metadata/catalog.json': Buffer.from(JSON.stringify({ schemaVersion: 1, styleGroups: [{ ...f.catalog.styleGroups[0], id: 'moe-solid' }], icons: [{ ...f.catalog.icons[0], availableIn: ['moe-solid'] }] })),
  }))).rejects.toThrow('differs');
});
it('rejects empty and full-download configurations before fetching any scoped metadata', async () => {
  const f = await fixture(); let loads = 0;
  const load = () => { loads++; return Promise.resolve({ 'manifest.json': Buffer.from('{}'), 'metadata/catalog.json': Buffer.from('{}') }); };
  await expect(planConfigPackagesFromMetadata({ ...f.config, icons: [] }, f.candidate, load)).rejects.toThrow('registered');
  await expect(planConfigPackagesFromMetadata({ ...f.config, downloadMode: 'full' }, f.candidate, load)).rejects.toThrow('full');
  expect(loads).toBe(0);
});
it('rejects stale catalog, full mode, empty selection and unavailable tier before any consumption', async () => {
  const f = await fixture();
  expect(() => planConfigPackages(f.config, { ...f.catalog, sourceVersion: '9.0.0' }, f.candidate)).toThrow('identity');
  expect(() => planConfigPackages({ ...f.config, downloadMode: 'full' }, f.catalog, f.candidate)).toThrow('full');
  expect(() => planConfigPackages({ ...f.config, icons: [] }, f.catalog, f.candidate)).toThrow('registered');
  const free = await fixture('free'); expect(() => planConfigPackages({ ...free.config, defaultTheme: 'blue', themes: { blue: { styleGroup: 'moe-blue', format: 'png', imageSize: 128 } } }, free.catalog, free.candidate)).toThrow('tier');
});
it('maps verified actual generator SVG package to assets and keeps code/shared/metadata in separate scoped areas', () => {
  const actual = JSON.parse(fs.readFileSync(new URL('./fixtures/small-package/row.json', import.meta.url), 'utf8')) as PackageRow;
  const files = verifySelectedPackage(actual, fs.readFileSync(new URL('./fixtures/small-package/svg.tgz', import.meta.url)));
  const mapped = packageTargetFiles(actual, files, 'assets'); expect(mapped.area).toBe('assets'); expect(Object.keys(mapped.files)).toEqual(['moe-outline/sample.svg']);
  expect(packageTargetFiles(actual, files, 'vanilla')).toMatchObject({ area: 'assets' });
  const fake = { 'manifest.json': Buffer.from('{}'), 'index.js': Buffer.from('export{}') };
  expect(Object.keys(packageTargetFiles(row('code','pro','moe-outline','react'),fake,'react').files)).toEqual(['moe-outline/index.js']);
  expect(Object.keys(packageTargetFiles(row('shared','pro',undefined,'react'),fake,'react').files)).toEqual(['index.js']);
  expect(packageTargetFiles(row('metadata','pro','moe-outline'), { 'manifest.json': Buffer.from('{}'), 'metadata/catalog.json': Buffer.from('{}') }, 'react')).toMatchObject({ area: 'metadata' });
  expect(() => packageTargetFiles(row('code','pro','moe-outline','react'),fake,'vue')).toThrow('target mismatch');
  expect(() => packageTargetFiles(row('shared','pro',undefined,'react'), { ...fake, '../escape.js': Buffer.from('x') }, 'react')).toThrow('unsafe');
});
