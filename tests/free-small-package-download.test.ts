import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { downloadFreeSelectedPackages, downloadFreeStablePackages, downloadFreeVersionPackages } from '../src/core/free-small-package-download.js';
import { planConfigPackagesFromMetadata } from '../src/core/config-package-plan.js';
import { runInstallUseCase } from '../src/core/install.js';
import { runLibraryUpdateUseCase } from '../src/core/library-update.js';
import { runMetadataSyncUseCase } from '../src/core/metadata-sync.js';
import { runGenerateUseCase } from '../src/core/generate.js';
import { runDoctorDiagnose } from '../src/core/doctor.js';
import { readInstalledResourceState } from '../src/project/install-metadata.js';
import { parsePackageInstallMetadata } from '../src/project/package-install-metadata.js';
import type { FreeCandidateVersionPointer } from '../src/core/candidate-version-pointer.js';
import { buildCandidateSet, canonicalBytes, sha256, type PackageRow } from '../src/core/small-pack/candidate-set.cjs';
import { createTarGz } from '../src/project/tar-gz.js';
function pack(kind: 'shared' | 'svg' | 'code' | 'metadata', group?: string, target: 'react' | 'vue' | 'vanilla' = 'react', fullVersion = '1.0.0', codeValue: 'true' | 'false' = 'true') {
  const scope = { kind, tier: 'free' as const, ...(group ? { styleGroupId: group } : {}), ...(['shared', 'code'].includes(kind) ? { target } : {}) };
  const payloads: Record<string, Uint8Array> = kind === 'svg' ? { 'sample.svg': Buffer.from('<svg/>') }
    : kind === 'metadata' ? {
        'metadata/MANUAL.md': Buffer.from('# Moeicons'),
        'metadata/catalog.json': Buffer.from(JSON.stringify({ schemaVersion: 1, styleGroups: [{ id: group, type: 'outline', tiers: ['free'], formats: ['svg'], imageSizes: [] }], icons: [{ id: 'sample', prefix: 'sample-', label: 'sample', aliases: [], availableIn: [group] }] })),
        'metadata/manifest.json': Buffer.from('{}'),
      }
      : kind === 'code'
        ? { 'index.js': Buffer.from(`export const sample = ${codeValue};`), 'Sample.js': Buffer.from('export default function Sample() {}') }
        : { 'index.js': Buffer.from('export const helper = true;'), 'types.ts': Buffer.from('export interface ReactIconProps {}\nexport interface VueIconProps {}\nexport interface VanillaIconOptions {}\n') };
  const manifest = canonicalBytes({ schemaVersion: 1, ...scope, files: Object.entries(payloads).map(([path, data]) => ({ path, byteSize: data.length, sha256: sha256(data) })) });
  const bytes = createTarGz({ ...payloads, 'manifest.json': manifest }); const digest = sha256(bytes);
  const resourceKey = kind === 'shared' ? `shared/free/${target}` : kind === 'code' ? `code/free/${target}/${group}` : `${kind}/free/${group}`;
  const row: PackageRow = { ...scope, resourceKey, packageSha256: digest, filename: `packages/${digest}.tgz`, fullVersion, compressedBytes: bytes.length, expandedBytes: Object.values(payloads).reduce((sum, data) => sum + data.length, 0) + manifest.length, fileCount: Object.keys(payloads).length + 1, dependencies: [] };
  return { row, bytes };
}

function packageSetCandidate(fullVersion: string, styleGroupId: string, codeValue: 'true' | 'false') {
  const shared = pack('shared', undefined, 'react', fullVersion);
  const code = pack('code', styleGroupId, 'react', fullVersion, codeValue);
  const metadata = pack('metadata', styleGroupId, 'react', fullVersion);
  code.row.dependencies = [shared.row.packageSha256];
  const units = [shared, code, metadata];
  const built = buildCandidateSet({ fullVersion, tier: 'free', sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packages: units.map(unit => unit.row) });
  const identity = {
    schemaVersion: 1, tier: 'free' as const, fullVersion,
    sourceCommit: built.candidateSet.sourceCommit, generatorCommit: built.candidateSet.generatorCommit,
    packageSetSha256: built.candidateSet.packageSetSha256,
    candidateRootSha256: sha256(built.rootBytes), candidateRootBytes: built.rootBytes.length,
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
  return { built, identity, units };
}
async function fixture() {
  const cacheDir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-free-small-http-'));
  const shared = pack('shared'), vanillaShared = pack('shared', undefined, 'vanilla'), selected = pack('svg', 'moe-selected'), outlineSvg = pack('svg', 'moe-outline'), other = pack('svg', 'moe-solid'), outlineMetadata = pack('metadata', 'moe-outline'), solidMetadata = pack('metadata', 'moe-solid'), outlineCode = pack('code', 'moe-outline'), outlineVanillaCode = pack('code', 'moe-outline', 'vanilla');
  selected.row.dependencies = [shared.row.packageSha256];
  outlineCode.row.dependencies = [shared.row.packageSha256];
  outlineVanillaCode.row.dependencies = [vanillaShared.row.packageSha256];
  const units = [shared, vanillaShared, selected, outlineSvg, other, outlineMetadata, solidMetadata, outlineCode, outlineVanillaCode];
  const built = buildCandidateSet({ fullVersion: '1.0.0', tier: 'free', sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packages: units.map(u => u.row) });
  const tag = `candidate-set-v1-free-${built.candidateSet.packageSetSha256}`; const prefix = '/moewolf-dev/moe-icons/releases/download/';
  const pointerTag = `candidate-version-v1-free-${built.candidateSet.fullVersion}`;
  const pointer = canonicalBytes({ schemaVersion: 1, tier: 'free', fullVersion: built.candidateSet.fullVersion, sourceCommit: built.candidateSet.sourceCommit, generatorCommit: built.candidateSet.generatorCommit, packageSetSha256: built.candidateSet.packageSetSha256, candidateRootSha256: sha256(built.rootBytes), candidateRootBytes: built.rootBytes.length });
  const identity = Buffer.from(JSON.stringify({ schemaVersion: 1, tier: 'free', fullVersion: built.candidateSet.fullVersion, sourceCommit: built.candidateSet.sourceCommit, generatorCommit: built.candidateSet.generatorCommit, packageSetSha256: built.candidateSet.packageSetSha256, candidateRootSha256: sha256(built.rootBytes), candidateRootBytes: built.rootBytes.length, updatedAt: '2026-10-17T00:00:00.000Z' }));
  const bodies = new Map<string, Uint8Array>([[`${prefix}${tag}/candidate-set-free.json`, built.rootBytes], [`${prefix}${pointerTag}/candidate-version-free.json`, pointer], ...[...built.pageBytesByName].map(([name, bytes]) => [`${prefix}${tag}/${name}`, bytes] as [string, Uint8Array]), ...units.map(u => [`${prefix}free-package-v1-${u.row.packageSha256}/${u.row.packageSha256}.tgz`, u.bytes] as [string, Uint8Array])]);
  const workerBodies = new Map<string, Uint8Array>([
    ['/v1/icon-library/free/package-set/root', built.rootBytes],
    ...built.candidateSet.packagePages.map((ref, index) => [`/v1/icon-library/free/package-set/pages/${index + 1}`, built.pageBytesByName.get(ref.filename)!] as [string, Uint8Array]),
    ...units.map(unit => [`/v1/icon-library/free/package-set/packages/${unit.row.packageSha256}.tgz`, unit.bytes] as [string, Uint8Array]),
  ]);
  const calls: string[] = [], auth: (string | undefined)[] = []; const flags: { failOnce?: string; status?: number; corrupt?: string; oversize?: string; redirect?: boolean } = {};
  const server = createServer((request, response) => {
    const path = request.url!; calls.push(path); auth.push(request.headers.authorization);
    if (path.startsWith('/v1/icon-library/free/package-set?')) {
      response.writeHead(200, { 'content-length': identity.length }); response.end(identity); return;
    }
    const parsed = new URL(path, 'http://127.0.0.1');
    const workerBody = workerBodies.get(parsed.pathname);
    if (workerBody) { response.writeHead(200, { 'content-length': workerBody.length }); response.end(workerBody); return; }
    if (flags.failOnce === path) { delete flags.failOnce; response.writeHead(503).end(); return; }
    if (flags.status && path.endsWith('.tgz')) { response.writeHead(flags.status).end(); return; }
    if (flags.redirect && path.endsWith('.tgz')) { response.writeHead(302, { location: 'https://untrusted.invalid/package.tgz' }).end(); return; }
    const body = bodies.get(path); if (!body) { response.writeHead(404).end(); return; }
    if (flags.oversize === path) { response.writeHead(200, { 'content-length': body.length + 1 }).end(Buffer.alloc(body.length + 1)); return; }
    response.writeHead(200, { 'content-length': body.length }); response.end(flags.corrupt === path ? Buffer.alloc(body.length) : body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('no port');
  const options = { expected: built.candidateSet, resourceKeys: [selected.row.resourceKey], cacheDir, fixtureOrigin: `http://127.0.0.1:${address.port}/`, consume: async () => {} };
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(cacheDir, { recursive: true, force: true }); };
  return { options, close, calls, auth, flags, selected, shared, vanillaShared, other, outlineMetadata, solidMetadata, outlineCode, outlineVanillaCode, bodies };
}
it('real HTTP cold install requests only selected dependency closure; warm install sends no requests', async () => {
  const f = await fixture(); try {
    const report = await downloadFreeSelectedPackages(f.options);
    expect(report.packageCount).toBe(2); expect(report.networkBytes).toBe(f.shared.bytes.length + f.selected.bytes.length);
    expect(f.calls.filter(path => path.endsWith('.tgz'))).toEqual([expect.stringContaining(f.shared.row.packageSha256), expect.stringContaining(f.selected.row.packageSha256)]);
    expect(f.calls.some(path => path.includes(f.other.row.packageSha256))).toBe(false); expect(f.auth.every(value => value === undefined)).toBe(true);
    f.calls.length = 0; const warm = await downloadFreeSelectedPackages(f.options); expect(warm.networkBytes).toBe(0); expect(warm.metadataNetworkBytes).toBe(0); expect(warm.cacheHits).toBe(2); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});
it('resolves a version through its immutable pointer, binds the exact root, and caches pointer only after selected units verify', async () => {
  const f = await fixture(); try {
    const options = { resourceKeys: f.options.resourceKeys, cacheDir: f.options.cacheDir, fixtureOrigin: f.options.fixtureOrigin, consume: f.options.consume, fullVersion: '1.0.0' };
    const first = await downloadFreeVersionPackages(options);
    expect(first.packageCount).toBe(2); expect(first.networkBytes).toBe(f.shared.bytes.length + f.selected.bytes.length);
    expect(f.calls[0]).toContain('/candidate-version-v1-free-1.0.0/candidate-version-free.json');
    expect(f.calls.some(path => path.includes(f.other.row.packageSha256))).toBe(false);
    expect(fs.existsSync(join(options.cacheDir, 'small-pack-v1/free/version-1.0.0.json'))).toBe(true);
    f.calls.length = 0; const warm = await downloadFreeVersionPackages(options);
    expect(warm.metadataNetworkBytes).toBe(0); expect(warm.metadataCacheHits).toBe(3); expect(warm.cacheHits).toBe(2); expect(f.calls).toEqual([]);
    fs.writeFileSync(join(options.cacheDir, 'small-pack-v1/free/version-1.0.0.json'), Buffer.from('{}')); f.calls.length = 0;
    await expect(downloadFreeVersionPackages(options)).rejects.toThrow('pointer'); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});
it('discovers the Free stable set from the Worker API and installs only the selected dependency closure', async () => {
  const f = await fixture(); try {
    const report = await downloadFreeStablePackages({
      resourceKeys: f.options.resourceKeys,
      cacheDir: f.options.cacheDir,
      apiBaseUrl: f.options.fixtureOrigin,
      consume: f.options.consume,
    });
    expect(report.packageCount).toBe(2);
    expect(f.calls[0]).toBe('/v1/icon-library/free/package-set?version=stable');
    expect(f.calls.filter(path => path.includes('/packages/') && path.endsWith('.tgz?version=1.0.0&packageSetSha256=' + f.options.expected.packageSetSha256))).toHaveLength(2);
    expect(f.calls.some(path => path.includes(f.other.row.packageSha256))).toBe(false);
  } finally { await f.close(); }
});
it('an update pins the exact stable set identity before reading selected Worker objects', async () => {
  const f = await fixture(); try {
    const report = await downloadFreeVersionPackages({
      fullVersion: '1.0.0', expectedPackageSetSha256: f.options.expected.packageSetSha256,
      resourceKeys: f.options.resourceKeys, cacheDir: f.options.cacheDir,
      apiBaseUrl: f.options.fixtureOrigin, consume: f.options.consume,
    });
    expect(report.packageCount).toBe(2);
    expect(f.calls[0]).toBe(`/v1/icon-library/free/package-set?version=1.0.0&packageSetSha256=${f.options.expected.packageSetSha256}`);
    expect(f.calls.filter(path => path.includes('/v1/icon-library/free/package-set/packages/') && path.endsWith(`?version=1.0.0&packageSetSha256=${f.options.expected.packageSetSha256}`))).toHaveLength(2);
  } finally { await f.close(); }
});
it('package-set library update uses the exact Free Worker identity and transactionally reconciles the installed set', async () => {
  const f = await fixture();
  const project = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-small-package-update-'));
  try {
    fs.writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    fs.writeFileSync(join(project, 'moeicons.config.json'), JSON.stringify({ schemaVersion: 3, tier: 'free', target: 'react', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline', themes: { outline: { styleGroup: 'moe-outline' } }, downloadMode: 'icons' }));
    const context = { cwd: project, env: {}, signal: new AbortController().signal, now: () => new Date('2026-10-17T00:00:00.000Z'), ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note: () => undefined, progress: () => ({ stop: () => undefined }) } };
    const txFs = { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, existsSync: fs.existsSync, renameSync: fs.renameSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, copyFileSync: fs.copyFileSync };
    const free = {
      cacheDir: f.options.cacheDir, cliVersion: '0.1.0', fixtureBaseUrl: f.options.fixtureOrigin, fetchFn: globalThis.fetch.bind(globalThis),
      readFileSync: (path: string) => new Uint8Array(fs.readFileSync(path)),
      writeFileSync: (path: string, data: Uint8Array) => fs.writeFileSync(path, data),
      mkdirSync: (path: string) => fs.mkdirSync(path, { recursive: true }),
      existsSync: fs.existsSync, renameSync: fs.renameSync, rmSync: fs.rmSync, readdirSync: fs.readdirSync,
    };
    const installed = await runInstallUseCase(context, { fs: txFs, download: free }, { sourceVersion: '1.0.0' });
    expect(installed).toMatchObject({ ok: true, packageSetSha256: f.options.expected.packageSetSha256 });
    const result = await runLibraryUpdateUseCase(context, { fs: txFs, free, auth: {}, fetch: globalThis.fetch.bind(globalThis) }, {
      tier: 'free', version: '1.0.0', descriptorSha256: f.options.expected.packageSetSha256, packageSetSha256: f.options.expected.packageSetSha256,
    });
    expect(result).toMatchObject({ artifactVersion: '1.0.0', downloadMode: 'packages' });
    expect(result.files).toContain('.moeicons/catalog.json');
    expect(fs.existsSync(join(project, 'src/icons/icons/Sample.tsx'))).toBe(false);
    expect(fs.existsSync(join(project, '.moeicons/install-metadata.json'))).toBe(true);
    expect(fs.readFileSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'), 'utf8')).toBe('export const sample = true;');
    const codeBeforeRefresh = fs.readFileSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'));
    fs.rmSync(join(project, '.moeicons/catalog.json'));
    fs.rmSync(join(project, '.moeicons/package-metadata/moe-outline/catalog.json'));
    fs.rmSync(join(f.options.cacheDir, 'small-pack-v1/free', `${f.outlineMetadata.row.packageSha256}.tgz`), { force: true });
    f.calls.length = 0;
    const refreshed = await runMetadataSyncUseCase(context, { fs: txFs, free, auth: {}, fetch: globalThis.fetch.bind(globalThis) });
    expect(refreshed).toMatchObject({ tier: 'free', artifactVersion: '1.0.0', networkBytes: expect.any(Number) });
    expect(fs.existsSync(join(project, '.moeicons/catalog.json'))).toBe(true);
    expect(fs.existsSync(join(project, '.moeicons/package-metadata/moe-outline/catalog.json'))).toBe(true);
    expect(fs.readFileSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'))).toEqual(codeBeforeRefresh);
    expect(f.calls.filter(path => path.endsWith('.tgz'))).toHaveLength(1);
    expect(f.calls.find(path => path.endsWith('.tgz'))).toContain(f.outlineMetadata.row.packageSha256);
    await expect(runLibraryUpdateUseCase(context, { fs: txFs, free, auth: {}, fetch: globalThis.fetch.bind(globalThis) }, {
      tier: 'free', version: '1.0.0', descriptorSha256: 'f'.repeat(64), packageSetSha256: 'f'.repeat(64),
    })).rejects.toThrow(/identity changed for the installed version/);
  } finally { fs.rmSync(project, { recursive: true, force: true }); await f.close(); }
});
it('applies a code-only package change with one payload fetch, then removes a deleted style group atomically', async () => {
  const initial = packageSetCandidate('1.0.0', 'moe-outline', 'true');
  const codeUpdate = packageSetCandidate('1.0.1', 'moe-outline', 'false');
  const groupUpdate = packageSetCandidate('1.0.2', 'moe-solid', 'true');
  const byVersion = new Map([[initial.identity.fullVersion, initial], [codeUpdate.identity.fullVersion, codeUpdate], [groupUpdate.identity.fullVersion, groupUpdate]]);
  const requests: string[] = [];
  let unexpectedAuth = false;
  let failPackageDigestOnce: string | undefined;
  const apiPath = '/v1/icon-library/free/package-set';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(`${url.pathname}${url.search}`);
    if (request.method !== 'GET' || request.headers.authorization) {
      unexpectedAuth = true;
      response.writeHead(403).end();
      return;
    }
    const requestedVersion = url.searchParams.get('version');
    const candidate = requestedVersion === 'stable' ? initial : byVersion.get(requestedVersion ?? '');
    if (!candidate) { response.writeHead(404).end(); return; }
    const send = (value: Uint8Array | string, contentType = 'application/json') => {
      const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      response.writeHead(200, { 'content-type': contentType, 'content-length': String(bytes.byteLength) });
      response.end(bytes);
    };
    if (url.pathname === apiPath) { send(JSON.stringify(candidate.identity)); return; }
    if (url.pathname === `${apiPath}/root`) { send(candidate.built.rootBytes, 'application/json'); return; }
    const pageMatch = /^\/v1\/icon-library\/free\/package-set\/pages\/(\d+)$/.exec(url.pathname);
    if (pageMatch) {
      const pageRef = candidate.built.candidateSet.packagePages[Number(pageMatch[1]) - 1];
      const page = pageRef && candidate.built.pageBytesByName.get(pageRef.filename);
      if (!page) { response.writeHead(404).end(); return; }
      send(page, 'application/json');
      return;
    }
    const packageMatch = /^\/v1\/icon-library\/free\/package-set\/packages\/([a-f0-9]{64})\.tgz$/.exec(url.pathname);
    if (packageMatch) {
      const unit = candidate.units.find(item => item.row.packageSha256 === packageMatch[1]);
      if (!unit) { response.writeHead(404).end(); return; }
      if (failPackageDigestOnce === packageMatch[1]) {
        failPackageDigestOnce = undefined;
        response.writeHead(403).end();
        return;
      }
      send(unit.bytes, 'application/gzip');
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('package-set update fixture did not bind a TCP port');
  const fixtureOrigin = `http://127.0.0.1:${address.port}/`;
  const project = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-package-set-transition-'));
  const cacheDir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-package-set-transition-cache-'));
  try {
    fs.writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    const configPath = join(project, 'moeicons.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 3, tier: 'free', target: 'react', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline', themes: { outline: { styleGroup: 'moe-outline' } }, downloadMode: 'icons' }));
    const context = {
      cwd: project, env: { MOEICONS_API_BASE_URL: fixtureOrigin }, signal: new AbortController().signal,
      now: () => new Date('2026-10-18T00:00:00.000Z'),
      ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note: () => undefined, progress: () => ({ stop: () => undefined }) },
    };
    const txFs = { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, existsSync: fs.existsSync, renameSync: fs.renameSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, copyFileSync: fs.copyFileSync };
    const free = {
      cacheDir, cliVersion: '0.1.0', fetchFn: globalThis.fetch.bind(globalThis),
      readFileSync: (path: string) => new Uint8Array(fs.readFileSync(path)),
      writeFileSync: (path: string, data: Uint8Array) => fs.writeFileSync(path, data),
      mkdirSync: (path: string) => fs.mkdirSync(path, { recursive: true }),
      existsSync: fs.existsSync, renameSync: fs.renameSync, rmSync: fs.rmSync, readdirSync: fs.readdirSync,
    };

    const installed = await runInstallUseCase(context, { fs: txFs, download: free }, {});
    if (!installed.ok) throw new Error(`initial package-set install failed: ${JSON.stringify(installed)}; requests=${JSON.stringify(requests)}`);
    expect(installed).toMatchObject({ ok: true, artifactVersion: '1.0.0', packageCount: 3 });
    expect(fs.readFileSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'), 'utf8')).toBe('export const sample = true;');

    requests.length = 0;
    const codePackageSha256 = codeUpdate.units.find(unit => unit.row.kind === 'code')!.row.packageSha256;
    const beforeFailedUpdateMetadata = fs.readFileSync(join(project, '.moeicons/install-metadata.json'), 'utf8');
    failPackageDigestOnce = codePackageSha256;
    await expect(runLibraryUpdateUseCase(context, { fs: txFs, free, auth: {}, fetch: globalThis.fetch.bind(globalThis) }, {
      tier: 'free', version: '1.0.1', descriptorSha256: codeUpdate.identity.packageSetSha256,
      packageSetSha256: codeUpdate.identity.packageSetSha256,
    })).rejects.toThrow(/403/);
    expect(fs.readFileSync(join(project, '.moeicons/install-metadata.json'), 'utf8')).toBe(beforeFailedUpdateMetadata);
    expect(fs.readFileSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'), 'utf8')).toBe('export const sample = true;');
    expect(fs.readdirSync(join(project, '.moeicons')).some(name => name.startsWith('.package-stage-'))).toBe(false);
    expect(requests.filter(path => path.includes('/packages/'))).toHaveLength(1);
    expect(requests.find(path => path.includes('/packages/'))).toContain(codePackageSha256);

    requests.length = 0;
    const updatedCode = await runLibraryUpdateUseCase(context, { fs: txFs, free, auth: {}, fetch: globalThis.fetch.bind(globalThis) }, {
      tier: 'free', version: '1.0.1', descriptorSha256: codeUpdate.identity.packageSetSha256,
      packageSetSha256: codeUpdate.identity.packageSetSha256,
    });
    expect(updatedCode).toMatchObject({ artifactVersion: '1.0.1', downloadMode: 'packages' });
    expect(fs.readFileSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'), 'utf8')).toBe('export const sample = false;');
    const firstPayloadReads = requests.filter(path => path.includes('/packages/') && path.endsWith('.tgz?version=1.0.1&packageSetSha256=' + codeUpdate.identity.packageSetSha256));
    expect(firstPayloadReads).toEqual([expect.stringContaining(codePackageSha256)]);

    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 3, tier: 'free', target: 'react', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'solid', themes: { solid: { styleGroup: 'moe-solid' } }, downloadMode: 'icons' }));
    requests.length = 0;
    const removedGroup = await runLibraryUpdateUseCase(context, { fs: txFs, free, auth: {}, fetch: globalThis.fetch.bind(globalThis) }, {
      tier: 'free', version: '1.0.2', descriptorSha256: groupUpdate.identity.packageSetSha256,
      packageSetSha256: groupUpdate.identity.packageSetSha256,
    });
    expect(removedGroup).toMatchObject({ artifactVersion: '1.0.2', downloadMode: 'packages' });
    expect(fs.existsSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'))).toBe(false);
    expect(fs.readFileSync(join(project, '.moeicons/artifact/react/moe-solid/index.js'), 'utf8')).toBe('export const sample = true;');
    const installedMetadata = parsePackageInstallMetadata(fs.readFileSync(join(project, '.moeicons/install-metadata.json'), 'utf8'));
    expect(installedMetadata?.resourceKeys).toContain('code/free/react/moe-solid');
    expect(installedMetadata?.resourceKeys).not.toContain('code/free/react/moe-outline');
    expect(unexpectedAuth).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
it('a version pointer with a mismatched candidate root fails before package transfer and is not cached', async () => {
  const f = await fixture(); try {
    const valid = [...f.bodies.entries()].find(([path]) => path.endsWith('/candidate-version-free.json'))![1];
    const pointer = JSON.parse(Buffer.from(valid).toString()) as unknown as FreeCandidateVersionPointer;
    const bad = canonicalBytes({ ...pointer, candidateRootSha256: 'f'.repeat(64) }); const key = [...f.bodies.keys()].find(path => path.endsWith('/candidate-version-free.json'))!; f.bodies.set(key, bad);
    const options = { resourceKeys: f.options.resourceKeys, cacheDir: f.options.cacheDir, fixtureOrigin: f.options.fixtureOrigin, consume: f.options.consume, fullVersion: '1.0.0' };
    await expect(downloadFreeVersionPackages(options)).rejects.toThrow('version pointer');
    expect(f.calls.filter(path => path.endsWith('.tgz'))).toHaveLength(0);
    expect(fs.existsSync(join(options.cacheDir, 'small-pack-v1/free/version-1.0.0.json'))).toBe(false);
  } finally { await f.close(); }
});
it('resolves configured themes from verified scoped metadata and downloads only planned target units plus their dependency', async () => {
  const f = await fixture(); try {
    const config = { schemaVersion: 3 as const, tier: 'free' as const, target: 'react' as const, outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline', themes: { outline: { styleGroup: 'moe-outline' } } };
    const consumed: string[] = [];
    const report = await downloadFreeVersionPackages({
      cacheDir: f.options.cacheDir, fixtureOrigin: f.options.fixtureOrigin, fullVersion: '1.0.0',
      resolveResourceKeys: async (candidate, loadVerifiedPackage) => (await planConfigPackagesFromMetadata(config, candidate, loadVerifiedPackage)).resourceKeys,
      consume: (row) => { consumed.push(row.resourceKey); return Promise.resolve(); },
    });
    expect(consumed).toEqual(['shared/free/react', 'code/free/react/moe-outline', 'metadata/free/moe-outline']);
    expect(report.packageCount).toBe(3); expect(report.networkBytes).toBe(f.shared.bytes.length + f.outlineCode.bytes.length + f.outlineMetadata.bytes.length);
    expect(report.cacheHits).toBe(0); expect(f.calls.some(path => path.includes(f.selected.row.packageSha256))).toBe(false);
    expect(f.calls.some(path => path.includes(f.other.row.packageSha256))).toBe(false);
    expect(f.calls.filter(path => path.endsWith('.tgz'))).toHaveLength(3);
  } finally { await f.close(); }
});
it('production install entry installs the exact configured package closure transactionally with v2 identity', async () => {
  const f = await fixture();
  const project = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-small-package-install-'));
  try {
    fs.writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    fs.writeFileSync(join(project, 'moeicons.config.json'), JSON.stringify({
      schemaVersion: 3, tier: 'free', target: 'react', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline',
      themes: { outline: { styleGroup: 'moe-outline' } }, downloadMode: 'icons',
    }));
    const context = {
      cwd: project, env: { MOEICONS_API_BASE_URL: f.options.fixtureOrigin }, signal: new AbortController().signal, now: () => new Date('2026-10-17T00:00:00.000Z'),
      ui: { select: async () => 'free', confirm: async () => true, text: async () => '', note: () => undefined, progress: () => ({ stop: () => undefined }) },
    };
    const installDeps = {
      fs: { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, existsSync: fs.existsSync, renameSync: fs.renameSync, rmSync: fs.rmSync },
      download: {
        fetchFn: globalThis.fetch.bind(globalThis),
        readFileSync: (path: string) => new Uint8Array(fs.readFileSync(path)),
        writeFileSync: (path: string, bytes: Uint8Array) => fs.writeFileSync(path, bytes),
        mkdirSync: (path: string) => fs.mkdirSync(path, { recursive: true }),
        existsSync: fs.existsSync, renameSync: fs.renameSync, rmSync: fs.rmSync,
        cacheDir: f.options.cacheDir, cliVersion: '0.1.0',
      },
    };
    const result = await runInstallUseCase(context, installDeps, {});

    if (!result.ok) throw new Error(`small package install failed: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: true, downloadMode: 'packages', artifactVersion: '1.0.0', packageCount: 3 });
    expect(result.descriptorSha256).toBeUndefined();
    expect(result.packageSetSha256).toBeTruthy();
    expect(fs.readFileSync(join(project, '.moeicons/artifact/react/moe-outline/index.js'), 'utf8')).toBe('export const sample = true;');
    expect(fs.existsSync(join(project, '.moeicons/artifact/react/types.ts'))).toBe(true);
    expect(fs.existsSync(join(project, '.moeicons/artifact/react/index.js'))).toBe(true);
    expect(readInstalledResourceState(project, 'free').kind).toBe('ok');
    const metadata = parsePackageInstallMetadata(fs.readFileSync(join(project, '.moeicons/install-metadata.json'), 'utf8'));
    expect(metadata?.candidate.fullVersion).toBe('1.0.0');
    expect(metadata?.resourceKeys).toEqual(['code/free/react/moe-outline', 'metadata/free/moe-outline']);
    expect(metadata?.packages.map((row) => row.resourceKey)).toEqual(['code/free/react/moe-outline', 'metadata/free/moe-outline', 'shared/free/react']);
    expect(fs.readdirSync(join(project, '.moeicons')).some((name) => name.startsWith('.package-stage-'))).toBe(false);
    expect(f.calls[0]).toBe('/v1/icon-library/free/package-set?version=stable');
    expect(f.calls.some(path => path === `/v1/icon-library/free/package-set/root?version=1.0.0&packageSetSha256=${f.options.expected.packageSetSha256}`)).toBe(true);
    expect(f.calls.filter((path) => path.includes('/v1/icon-library/free/package-set/packages/'))).toHaveLength(3);
    expect(f.calls.some((path) => path.includes(f.other.row.packageSha256) || path.includes(f.selected.row.packageSha256))).toBe(false);
    expect(() => runDoctorDiagnose(project)).not.toThrow();
    const managedCode = join(project, '.moeicons/artifact/react/moe-outline/index.js');
    const originalCode = fs.readFileSync(managedCode);
    fs.writeFileSync(managedCode, 'tampered');
    expect(() => runDoctorDiagnose(project)).toThrow('managed file was modified');
    fs.writeFileSync(managedCode, originalCode);
    f.calls.length = 0;
    const warm = await runInstallUseCase(context, installDeps, {});
    if (!warm.ok) throw new Error(`warm package install failed: ${JSON.stringify(warm)}`);
    expect(warm).toMatchObject({ ok: true, downloadMode: 'packages', cacheHit: false });
    expect(warm.networkBytes).toBeGreaterThan(0);
    expect(f.calls.filter(path => path === '/v1/icon-library/free/package-set?version=stable')).toHaveLength(1);
    expect(f.calls.some(path => path.includes('/packages/'))).toBe(false);
    const generated = await runGenerateUseCase(context, fs, { noTailwind: true });
    expect(generated).toMatchObject({ ok: true });
    expect(fs.existsSync(join(project, 'src/icons/icons/Sample.tsx'))).toBe(true);
    const generatedMetadata = parsePackageInstallMetadata(fs.readFileSync(join(project, '.moeicons/install-metadata.json'), 'utf8'));
    expect(generatedMetadata?.generatedOutputDir).toBe('src/icons');
    expect(readInstalledResourceState(project, 'free').kind).toBe('ok');

    fs.writeFileSync(join(project, 'moeicons.config.json'), JSON.stringify({
      schemaVersion: 3, tier: 'free', target: 'assets', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'solid',
      themes: { solid: { styleGroup: 'moe-solid' } }, downloadMode: 'icons',
    }));
    const assetsInstall = await runInstallUseCase(context, installDeps, {});
    if (!assetsInstall.ok) throw new Error(`assets package install failed: ${JSON.stringify(assetsInstall)}`);
    expect(assetsInstall).toMatchObject({ ok: true, downloadMode: 'packages', packageCount: 2 });
    expect(fs.existsSync(join(project, '.moeicons/artifact/assets/manifest.json'))).toBe(true);
    const generatedAssets = await runGenerateUseCase(context, fs, { noTailwind: true });
    expect(generatedAssets).toMatchObject({ ok: true });
    expect(fs.existsSync(join(project, 'src/icons/assets/moe-solid/sample.svg'))).toBe(true);

    fs.writeFileSync(join(project, 'moeicons.config.json'), JSON.stringify({
      schemaVersion: 3, tier: 'free', target: 'vanilla', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline',
      themes: { outline: { styleGroup: 'moe-outline' } }, downloadMode: 'icons',
    }));
    const vanillaInstall = await runInstallUseCase(context, installDeps, {});
    if (!vanillaInstall.ok) throw new Error(`Vanilla package install failed: ${JSON.stringify(vanillaInstall)}`);
    expect(vanillaInstall).toMatchObject({ ok: true, downloadMode: 'packages', packageCount: 4 });
    const generatedVanilla = await runGenerateUseCase(context, fs, { noTailwind: true });
    expect(generatedVanilla).toMatchObject({ ok: true });
    expect(fs.existsSync(join(project, 'src/icons/moe-outline/Sample.ts'))).toBe(true);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    await f.close();
  }
});
it('503 retries only the failed independent unit; permission errors and missing packages never retry or fall back', async () => {
  const f = await fixture(); try {
    const target = [...f.bodies.keys()].find(path => path.includes(f.selected.row.packageSha256))!; f.flags.failOnce = target;
    const report = await downloadFreeSelectedPackages(f.options); expect(report.transferRetryCount).toBe(1); expect(f.calls.filter(path => path === target)).toHaveLength(2); expect(f.calls.filter(path => path.includes(f.shared.row.packageSha256))).toHaveLength(1);
  } finally { await f.close(); }
  for (const status of [403, 404]) { const failed = await fixture(); try { failed.flags.status = status; await expect(downloadFreeSelectedPackages(failed.options)).rejects.toThrow('HTTP_ERROR'); expect(failed.calls.filter(path => path.endsWith('.tgz'))).toHaveLength(1); } finally { await failed.close(); } }
});
it('oversized/corrupt payload and untrusted redirect are terminal without consumer or successful cache publication', async () => {
  for (const fault of ['oversize', 'corrupt', 'redirect'] as const) { const f = await fixture(); try {
    const target = [...f.bodies.keys()].find(path => path.includes(f.shared.row.packageSha256))!;
    if (fault === 'redirect') f.flags.redirect = true; else f.flags[fault] = target;
    let consumed = 0; await expect(downloadFreeSelectedPackages({ ...f.options, consume: () => { consumed++; return Promise.resolve(); } })).rejects.toThrow(); expect(consumed).toBe(0);
    expect(fs.existsSync(join(f.options.cacheDir, 'small-pack-v1/free', `${f.shared.row.packageSha256}.tgz`))).toBe(false);
    expect(f.calls.filter(path => path.endsWith('.tgz'))).toHaveLength(1);
  } finally { await f.close(); } }
});
it('bad cached package fails before network and cancellation or invalid fixture origin makes no request', async () => {
  const f = await fixture(); try {
    await downloadFreeSelectedPackages(f.options); const path = join(f.options.cacheDir, 'small-pack-v1/free', `${f.shared.row.packageSha256}.tgz`); fs.writeFileSync(path, Buffer.alloc(f.shared.bytes.length)); f.calls.length = 0;
    await expect(downloadFreeSelectedPackages(f.options)).rejects.toThrow(); expect(f.calls).toEqual([]);
    const controller = new AbortController(); controller.abort(); await expect(downloadFreeSelectedPackages({ ...f.options, signal: controller.signal })).rejects.toThrow();
    await expect(downloadFreeSelectedPackages({ ...f.options, fixtureOrigin: 'http://external.invalid/' })).rejects.toThrow('loopback'); expect(f.calls).toEqual([]);
    await expect(downloadFreeSelectedPackages({ ...f.options, resourceKeys: [] })).rejects.toThrow('selection'); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

it.skipIf(process.platform === 'win32')('rejects a symlinked cached package before reading or fetching payloads', async () => {
  const f = await fixture(); try {
    await downloadFreeSelectedPackages(f.options);
    const file = join(f.options.cacheDir, 'small-pack-v1/free', `${f.shared.row.packageSha256}.tgz`);
    const target = join(f.options.cacheDir, 'other-valid-package.tgz'); fs.writeFileSync(target, f.shared.bytes); fs.unlinkSync(file); fs.symlinkSync(target, file); f.calls.length = 0;
    await expect(downloadFreeSelectedPackages(f.options)).rejects.toThrow('non-link'); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});
