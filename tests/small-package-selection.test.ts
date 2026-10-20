import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifySmallPackPin } from '../scripts/verify-small-pack-pin.mjs';
import { canonicalBytes, sha256, buildCandidateSet, validatePackagePages, type PackageRow } from '../src/core/small-pack/candidate-set.cjs';
import { createTarGz } from '../src/project/tar-gz.js';
import { readSelectedCandidate, consumeSelectedPackages, planSelectedPackages, verifySelectedPackage, type SelectedCandidate } from '../src/core/small-package-selection.js';
function unit(kind: 'svg' | 'code' | 'shared', group: string | undefined, dependencies: string[] = []) {
  const scope = { kind, tier: 'free' as const, ...(group ? { styleGroupId: group } : {}), ...(kind !== 'svg' ? { target: 'react' } : {}) };
  const name = kind === 'svg' ? 'sample.svg' : 'index.js'; const payload = Buffer.from(kind === 'svg' ? '<svg/>' : 'export const icon = 1;');
  const manifest = canonicalBytes({ schemaVersion: 1, ...scope, files: [{ path: name, byteSize: payload.length, sha256: sha256(payload) }] });
  const bytes = createTarGz({ [name]: payload, 'manifest.json': manifest }); const digest = sha256(bytes);
  const resourceKey = kind === 'svg' ? `svg/free/${group}` : kind === 'code' ? `code/free/react/${group}` : 'shared/free/react';
  const row: PackageRow = { ...scope, resourceKey, fullVersion: '1.0.0', packageSha256: digest, filename: `packages/${digest}.tgz`, compressedBytes: bytes.length, expandedBytes: payload.length + manifest.length, fileCount: 2, dependencies };
  return { row, bytes };
}
async function fixture() {
  const shared = unit('shared', undefined); const selected = unit('code', 'moe-outline', [shared.row.packageSha256]); const unrelated = unit('svg', 'moe-solid');
  const units = [shared, selected, unrelated]; const built = buildCandidateSet({ fullVersion: '1.0.0', tier: 'free', sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packages: units.map(u => u.row) });
  const candidate = await readSelectedCandidate(built.rootBytes, built.candidateSet, async ref => built.pageBytesByName.get(ref.filename)!);
  return { units, selected, unrelated, shared, candidate, built };
}
describe('small-package selection', () => {
  it('rejects cross-page digest aliases and unresolved dependency references', () => {
    const digest = 'f'.repeat(64);
    const first: PackageRow = { kind: 'svg', tier: 'free', styleGroupId: 'moe-outline', packageSha256: digest, filename: `packages/${digest}.tgz`, resourceKey: 'svg/free/moe-outline', fullVersion: '1.0.0', compressedBytes: 1, expandedBytes: 1, fileCount: 1, dependencies: [] };
    const second: PackageRow = { ...first, styleGroupId: 'moe-solid', resourceKey: 'svg/free/moe-solid' };
    const pages = [first, second].map(row => canonicalBytes({ schemaVersion: 1, fullVersion: '1.0.0', tier: 'free', packages: [row] }));
    const refs = pages.map((bytes, index) => ({ filename: `package-page-free-${String(index + 1).padStart(4, '0')}.json`, sha256: sha256(bytes), sizeBytes: bytes.length, packageCount: 1 }));
    const projection = { schemaVersion: 1 as const, fullVersion: '1.0.0', tier: 'free' as const, sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packagePageCount: refs.length, packagePages: refs };
    const root = { ...projection, packageSetSha256: sha256(canonicalBytes(projection)) };
    const pageMap = new Map(refs.map((ref, index) => [ref.filename, pages[index]!]));
    expect(() => validatePackagePages(root, pageMap)).toThrow('duplicate package digest across candidate set');

    const danglingDigest = 'd'.repeat(64);
    const dangling: PackageRow = { ...first, styleGroupId: 'moe-game-blue', packageSha256: danglingDigest, filename: `packages/${danglingDigest}.tgz`, resourceKey: 'svg/free/moe-game-blue', dependencies: ['e'.repeat(64)] };
    const danglingPage = canonicalBytes({ schemaVersion: 1, fullVersion: '1.0.0', tier: 'free', packages: [dangling] });
    const danglingRef = { filename: 'package-page-free-0001.json', sha256: sha256(danglingPage), sizeBytes: danglingPage.length, packageCount: 1 };
    const danglingProjection = { schemaVersion: 1 as const, fullVersion: '1.0.0', tier: 'free' as const, sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packagePageCount: 1, packagePages: [danglingRef] };
    const danglingRoot = { ...danglingProjection, packageSetSha256: sha256(canonicalBytes(danglingProjection)) };
    expect(() => validatePackagePages(danglingRoot, new Map([[danglingRef.filename, danglingPage]]))).toThrow('missing dependency package');
  });
  it('downloads only explicit unit and dependency closure in dependency order; warm cache transfers zero bytes', async () => {
    const f = await fixture(); const cache = new Map<string, Uint8Array>(), requested: string[] = [], consumed: string[] = [];
    const io = { readCache: async (row: PackageRow) => cache.get(row.packageSha256), writeCache: async (row: PackageRow, bytes: Uint8Array) => { cache.set(row.packageSha256, bytes); }, download: async (row: PackageRow) => { requested.push(row.resourceKey); return f.units.find(u => u.row.packageSha256 === row.packageSha256)!.bytes; }, consume: async (row: PackageRow) => { consumed.push(row.resourceKey); } };
    const result = await consumeSelectedPackages(f.candidate, [f.selected.row.resourceKey], io);
    expect(requested).toEqual([f.shared.row.resourceKey, f.selected.row.resourceKey]); expect(consumed).toEqual(requested); expect(result.networkBytes).toBe(f.shared.bytes.length + f.selected.bytes.length);
    requested.length = 0; consumed.length = 0;
    expect(await consumeSelectedPackages(f.candidate, [f.selected.row.resourceKey], io)).toEqual({ packageCount: 2, networkBytes: 0, cacheHits: 2 }); expect(requested).toEqual([]);
  });
  it('rejects wrong pin, corrupt pages, unknown selections and dependency cycles', async () => {
    const f = await fixture(); await expect(readSelectedCandidate(f.built.rootBytes, { ...f.built.candidateSet, tier: 'pro' }, async () => Buffer.from('{}'))).rejects.toThrow('pin');
    await expect(readSelectedCandidate(f.built.rootBytes, f.built.candidateSet, async () => Buffer.from('{}'))).rejects.toThrow();
    expect(() => planSelectedPackages(f.candidate, ['missing'])).toThrow('absent');
    const cyclic: SelectedCandidate = { root: f.candidate.root, rows: f.candidate.rows.map(row => row.kind === 'shared' ? { ...row, dependencies: [f.selected.row.packageSha256] } : row) };
    expect(() => planSelectedPackages(cyclic, [f.selected.row.resourceKey])).toThrow('cyclic');
  });
  it('bad cache or corrupt download never falls back and never reaches cache/consumer', async () => {
    const f = await fixture();
    for (const cached of [true, false]) { let downloads = 0, writes = 0, consumed = 0;
      await expect(consumeSelectedPackages(f.candidate, [f.unrelated.row.resourceKey], { readCache: async () => cached ? Buffer.from('bad') : undefined, writeCache: async () => { writes++; }, download: async () => { downloads++; return Buffer.from('bad'); }, consume: async () => { consumed++; } })).rejects.toThrow();
      expect(downloads).toBe(cached ? 0 : 1); expect(writes).toBe(0); expect(consumed).toBe(0);
    }
  });
  it('a later consumer failure keeps validated cache for recovery', async () => {
    const f = await fixture(); let cached = false;
    await expect(consumeSelectedPackages(f.candidate, [f.unrelated.row.resourceKey], { readCache: async () => undefined, writeCache: async () => { cached = true; }, download: async () => f.unrelated.bytes, consume: async () => { expect(cached).toBe(true); throw Error('target failed'); } })).rejects.toThrow('target failed');
  });
  it('vendored strict parsers retain pinned bytes', () => {
    expect(verifySmallPackPin().sourceCommit).toBe('24d7e9ea5d4ac7c338ee08995ebf09b485950092');
    const pin = JSON.parse(readFileSync(new URL('../src/core/small-pack/PIN.json', import.meta.url), 'utf8')) as { files: Record<string, string> };
    for (const [name, digest] of Object.entries(pin.files)) expect(sha256(readFileSync(new URL('../src/core/small-pack/' + name, import.meta.url)))).toBe(digest);
  });
  it('validates vendored parser pins before build cleanup and npm publication', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.prebuild).toMatch(/^node scripts\/verify-small-pack-pin\.mjs &&/);
    expect(pkg.scripts.prepublishOnly).toMatch(/^node scripts\/verify-small-pack-pin\.mjs &&/);
  });
});

it('selected payload volume stays constant as unrelated historical groups grow', async () => {
  const f = await fixture();
  const history = Array.from({ length: 100 }, (_, i) => unit('svg', `moe-history-${i}`));
  const built = buildCandidateSet({ fullVersion: '1.0.0', tier: 'free', sourceCommit: f.candidate.root.sourceCommit, generatorCommit: f.candidate.root.generatorCommit, packages: [...f.candidate.rows, ...history.map(u => u.row)] });
  const candidate = await readSelectedCandidate(built.rootBytes, built.candidateSet, async ref => built.pageBytesByName.get(ref.filename)!);
  const fetched: string[] = [];
  const report = await consumeSelectedPackages(candidate, [f.selected.row.resourceKey], { readCache: async () => undefined, writeCache: async () => {}, consume: async () => {}, download: async row => { fetched.push(row.resourceKey); return f.units.find(u => u.row.resourceKey === row.resourceKey)!.bytes; } });
  expect(fetched).toEqual([f.shared.row.resourceKey, f.selected.row.resourceKey]);
  expect(report.networkBytes).toBe(f.shared.bytes.length + f.selected.bytes.length);
});

it('consumes an actual deterministic generator package through the new CLI verifier', async () => {
  const row = JSON.parse(readFileSync(new URL('./fixtures/small-package/row.json', import.meta.url), 'utf8')) as PackageRow;
  const payload = readFileSync(new URL('./fixtures/small-package/svg.tgz', import.meta.url));
  const built = buildCandidateSet({ fullVersion: row.fullVersion, tier: row.tier, sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packages: [row] });
  const candidate = await readSelectedCandidate(built.rootBytes, built.candidateSet, async ref => built.pageBytesByName.get(ref.filename)!);
  let count = 0;
  const report = await consumeSelectedPackages(candidate, [row.resourceKey], { readCache: async () => undefined, writeCache: async () => {}, download: async () => payload, consume: async (_, files) => { expect(Buffer.from(files['sample.svg']!).toString()).toContain('<svg'); count++; } });
  expect(report.packageCount).toBe(1); expect(count).toBe(1);
});


it('rejects validly hashed packages with foreign manifests or nested aggregate payloads, and gzip CRC damage', () => {
  for (const kind of ['scope', 'nested']) {
    const source = unit('svg', 'moe-outline');
    const path = kind === 'nested' ? 'renamed.svg.tgz' : 'sample.svg'; const data = Buffer.from('<svg/>');
    const manifest = canonicalBytes({ schemaVersion: 1, kind: 'svg', tier: kind === 'scope' ? 'pro' : 'free', styleGroupId: 'moe-outline', files: [{ path, byteSize: data.length, sha256: sha256(data) }] });
    const bytes = createTarGz({ [path]: data, 'manifest.json': manifest }); const digest = sha256(bytes);
    const row = { ...source.row, packageSha256: digest, filename: `packages/${digest}.tgz`, compressedBytes: bytes.length, expandedBytes: data.length + manifest.length };
    expect(() => verifySelectedPackage(row, bytes)).toThrow();
  }
  const source = unit('svg', 'moe-outline'); const damaged = Buffer.from(source.bytes); damaged[damaged.length - 8] = damaged[damaged.length - 8]! ^ 1;
  const digest = sha256(damaged);
  expect(() => verifySelectedPackage({ ...source.row, packageSha256: digest, filename: `packages/${digest}.tgz` }, damaged)).toThrow();
});
