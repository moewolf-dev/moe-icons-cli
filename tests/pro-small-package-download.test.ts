import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { downloadProStablePackages, downloadProVersionPackages, fetchProStablePackageSet } from '../src/core/pro-small-package-download.js';
import { runProInstallUseCase } from '../src/core/pro-install.js';
import { runLibraryUpdateUseCase } from '../src/core/library-update.js';
import { runMetadataSyncUseCase } from '../src/core/metadata-sync.js';
import { runProPreviewPackageWarmupUseCase } from '../src/core/pro-resources.js';
import { readInstalledResourceState } from '../src/project/install-metadata.js';
import { main } from '../src/cli.js';
import { buildCandidateSet, canonicalBytes, sha256, type PackageRow } from '../src/core/small-pack/candidate-set.cjs';
import { createTarGz } from '../src/project/tar-gz.js';

function pack(kind: 'shared' | 'code' | 'metadata' | 'bitmap', group?: string, target: 'react' | 'vue' | 'vanilla' = 'react') {
  const scope = { kind, tier: 'pro' as const, ...(group ? { styleGroupId: group } : {}),
    ...(['shared', 'code'].includes(kind) ? { target } : {}),
    ...(kind === 'bitmap' ? { variant: { width: 128, height: 128, format: 'webp' as const } } : {}) };
  const payloads: Record<string, Uint8Array> = kind === 'shared'
    ? { 'index.js': Buffer.from('export const helper = true;'), 'types.ts': Buffer.from('export interface ReactIconProps {}\n') }
    : kind === 'code'
      ? { 'index.js': Buffer.from('export const sample = true;'), 'Sample.js': Buffer.from('export default function Sample() {}') }
      : kind === 'bitmap'
        ? { 'icons/sample.webp': Buffer.from('RIFF\x18\x00\x00\x00WEBPVP8L\x0b\x00\x00\x00\x2f\x00\x00\x00\x00\x00\x00') }
        : {
          'metadata/MANUAL.md': Buffer.from('# Moeicons Pro'),
          'metadata/catalog.json': Buffer.from(JSON.stringify({ schemaVersion: 1, styleGroups: [{ id: group, type: 'outline', tiers: ['pro'], formats: ['svg'], imageSizes: [] }], icons: [{ id: 'sample', prefix: 'sample-', label: 'sample', aliases: [], availableIn: [group] }] })),
          'metadata/manifest.json': Buffer.from('{}'),
        };
  const manifest = canonicalBytes({ schemaVersion: 1, ...scope, files: Object.entries(payloads).map(([path, data]) => ({ path, byteSize: data.length, sha256: sha256(data) })) });
  const bytes = createTarGz({ ...payloads, 'manifest.json': manifest });
  const digest = sha256(bytes);
  const resourceKey = kind === 'shared' ? `shared/pro/${target}` : kind === 'code' ? `code/pro/${target}/${group}` : kind === 'metadata' ? `metadata/pro/${group}` : `bitmap/pro/${group}/128x128/webp`;
  const row: PackageRow = { ...scope, resourceKey, packageSha256: digest, filename: `packages/${digest}.tgz`, fullVersion: '1.0.0', compressedBytes: bytes.length, expandedBytes: Object.values(payloads).reduce((sum, data) => sum + data.length, 0) + manifest.length, fileCount: Object.keys(payloads).length + 1, dependencies: [] };
  return { row, bytes };
}

async function fixture() {
  const cacheDir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-pro-small-http-'));
  const shared = pack('shared');
  const selected = pack('code', 'moe-pro-outline');
  const unrelated = pack('code', 'moe-pro-solid');
  const metadata = pack('metadata', 'moe-pro-outline');
  const preview = pack('bitmap', 'moe-pro-bitmap');
  selected.row.dependencies = [shared.row.packageSha256];
  const units = [shared, selected, unrelated, metadata, preview];
  const built = buildCandidateSet({ fullVersion: '1.0.0', tier: 'pro', sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), packages: units.map(unit => unit.row) });
  const rootSha = sha256(built.rootBytes);
  const identity = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    tier: 'pro',
    fullVersion: '1.0.0',
    sourceCommit: built.candidateSet.sourceCommit,
    generatorCommit: built.candidateSet.generatorCommit,
    packageSetSha256: built.candidateSet.packageSetSha256,
    candidateRootSha256: rootSha,
    candidateRootBytes: built.rootBytes.length,
    updatedAt: '2026-10-17T00:00:00.000Z',
  }));
  const bodies = new Map<string, Uint8Array>([
    ['/v1/icon-library/pro/package-set/root', built.rootBytes],
    ...built.candidateSet.packagePages.map((ref, index) => [`/v1/icon-library/pro/package-set/pages/${index + 1}`, built.pageBytesByName.get(ref.filename)!] as [string, Uint8Array]),
    ...units.map(unit => [`/v1/icon-library/pro/package-set/packages/${unit.row.packageSha256}.tgz`, unit.bytes] as [string, Uint8Array]),
  ]);
  const calls: Array<{ path: string; authorization?: string; responseBytes: number }> = [];
  const flags: { failOnce?: string; failRemaining?: { path: string; count: number } } = {};
  let identityStatus = 200;
  const server = createServer((request, response) => {
    const path = request.url!;
    const call = { path, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), responseBytes: 0 };
    calls.push(call);
    if (request.headers.authorization !== 'Bearer pro-token') { response.writeHead(401).end(); return; }
    const parsed = new URL(path, 'http://127.0.0.1');
    if (parsed.pathname === '/v1/icon-library/pro/package-set') {
      if (identityStatus !== 200) { response.writeHead(identityStatus).end(); return; }
      if (parsed.searchParams.get('version') === 'stable' || parsed.searchParams.get('version') === '1.0.0' && parsed.searchParams.get('packageSetSha256') === built.candidateSet.packageSetSha256) {
        call.responseBytes = identity.byteLength;
        response.writeHead(200, { 'content-length': identity.length }); response.end(identity); return;
      }
      response.writeHead(404).end(); return;
    }
    if (flags.failOnce === parsed.pathname) { delete flags.failOnce; response.writeHead(503).end(); return; }
    if (flags.failRemaining?.path === parsed.pathname && flags.failRemaining.count > 0) {
      flags.failRemaining.count -= 1;
      response.writeHead(503).end(); return;
    }
    const body = bodies.get(parsed.pathname);
    if (!body) { response.writeHead(404).end(); return; }
    call.responseBytes = body.length;
    response.writeHead(200, { 'content-length': body.length }); response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no port');
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(cacheDir, { recursive: true, force: true }); };
  return { cacheDir, apiBaseUrl, close, calls, flags, built, identity, shared, selected, unrelated, metadata, preview, setIdentityStatus: (value: number) => { identityStatus = value; } };
}

function proSession() {
  return { accountId: 'acct-pro', accessToken: 'pro-token', refreshToken: 'refresh-placeholder', expiresAt: Date.now() + 60 * 60 * 1000, scope: 'openid profile', storedAt: Date.now() };
}

function tokenStore(session: ReturnType<typeof proSession>) {
  return { get: () => session, getActive: () => session, set: () => {}, delete: () => {}, clear: () => {} };
}

function transactionFs() {
  return { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, existsSync: fs.existsSync, renameSync: fs.renameSync, rmSync: fs.rmSync,
    readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, copyFileSync: fs.copyFileSync };
}

it('discovers the authenticated Pro stable set and downloads only a selected package dependency closure', async () => {
  const f = await fixture();
  try {
    const options = { cacheDir: f.cacheDir, apiBaseUrl: f.apiBaseUrl, accessToken: 'pro-token', resourceKeys: [f.selected.row.resourceKey], consume: async () => {} };
    const first = await downloadProStablePackages(options);
    expect(first.packageCount).toBe(2);
    expect(first.networkBytes).toBe(f.shared.bytes.length + f.selected.bytes.length);
    expect(f.calls[0]?.path).toBe('/v1/icon-library/pro/package-set?version=stable');
    expect(f.calls.every(call => call.authorization === 'Bearer pro-token')).toBe(true);
    expect(f.calls.some(call => call.path.includes(f.unrelated.row.packageSha256))).toBe(false);
    const cacheDir = join(f.cacheDir, 'small-pack-v1', 'pro');
    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
    for (const name of fs.readdirSync(cacheDir)) expect(fs.statSync(join(cacheDir, name)).mode & 0o777).toBe(0o600);
    f.calls.length = 0;
    const warm = await downloadProStablePackages(options);
    expect(warm.packageCount).toBe(2);
    expect(warm.networkBytes).toBe(0);
    expect(warm.cacheHits).toBe(2);
    expect(f.calls.some(call => call.path.includes('/packages/'))).toBe(false);
    expect(f.calls.every(call => call.authorization === 'Bearer pro-token')).toBe(true);
  } finally { await f.close(); }
});

it('retries only one transiently failed Pro package and reuses already verified units', async () => {
  const f = await fixture();
  try {
    const options = { cacheDir: f.cacheDir, apiBaseUrl: f.apiBaseUrl, accessToken: 'pro-token', resourceKeys: [f.selected.row.resourceKey], consume: async () => {} };
    const failedPath = `/v1/icon-library/pro/package-set/packages/${f.selected.row.packageSha256}.tgz`;
    f.flags.failOnce = failedPath;
    const report = await downloadProStablePackages(options);
    expect(report.packageCount).toBe(2);
    expect(report.transferRetryCount).toBe(1);
    expect(report.networkBytes).toBe(f.shared.bytes.length + f.selected.bytes.length);
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname === failedPath)).toHaveLength(2);
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname.includes(f.shared.row.packageSha256))).toHaveLength(1);
    expect(f.calls.some(call => call.path.includes(f.unrelated.row.packageSha256))).toBe(false);
    expect(f.calls.every(call => call.authorization === 'Bearer pro-token')).toBe(true);
    expect(fs.existsSync(join(f.cacheDir, 'small-pack-v1', 'pro', `${f.selected.row.packageSha256}.tgz`))).toBe(true);
  } finally { await f.close(); }
});

it('recovers after the Pro package retry budget is exhausted without refetching verified units', async () => {
  const f = await fixture();
  try {
    const options = { cacheDir: f.cacheDir, apiBaseUrl: f.apiBaseUrl, accessToken: 'pro-token', resourceKeys: [f.selected.row.resourceKey], consume: async () => {} };
    const failedPath = `/v1/icon-library/pro/package-set/packages/${f.selected.row.packageSha256}.tgz`;
    f.flags.failRemaining = { path: failedPath, count: 3 };
    await expect(downloadProStablePackages(options)).rejects.toThrow('request failed with 503');
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname === failedPath)).toHaveLength(3);
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname.includes(f.shared.row.packageSha256))).toHaveLength(1);
    const cacheDir = join(f.cacheDir, 'small-pack-v1', 'pro');
    expect(fs.existsSync(join(cacheDir, `${f.shared.row.packageSha256}.tgz`))).toBe(true);
    expect(fs.existsSync(join(cacheDir, `${f.selected.row.packageSha256}.tgz`))).toBe(false);

    f.calls.length = 0;
    f.flags.failRemaining.count = 0;
    const recovered = await downloadProStablePackages(options);
    expect(recovered.packageCount).toBe(2);
    expect(recovered.networkBytes).toBe(f.selected.bytes.length);
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname === failedPath)).toHaveLength(1);
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname.includes(f.shared.row.packageSha256))).toHaveLength(0);
    expect(fs.existsSync(join(cacheDir, `${f.selected.row.packageSha256}.tgz`))).toBe(true);
  } finally { await f.close(); }
});

it('binds exact-version Pro updates to the supplied immutable package-set SHA', async () => {
  const f = await fixture();
  try {
    const identity = await fetchProStablePackageSet({ accessToken: 'pro-token', apiBaseUrl: f.apiBaseUrl });
    const report = await downloadProVersionPackages({
      cacheDir: f.cacheDir,
      apiBaseUrl: f.apiBaseUrl,
      accessToken: 'pro-token',
      fullVersion: identity.fullVersion,
      expectedPackageSetSha256: identity.packageSetSha256,
      resourceKeys: [f.selected.row.resourceKey],
      consume: async () => {},
    });
    expect(report.packageCount).toBe(2);
    expect(f.calls.some(call => call.path === `/v1/icon-library/pro/package-set?version=1.0.0&packageSetSha256=${f.built.candidateSet.packageSetSha256}`)).toBe(true);
  } finally { await f.close(); }
});

it('fails on missing/invalid Pro credentials or lost entitlement before requesting package payloads', async () => {
  const f = await fixture();
  try {
    await expect(downloadProStablePackages({ cacheDir: f.cacheDir, apiBaseUrl: f.apiBaseUrl, accessToken: '', resourceKeys: [f.selected.row.resourceKey], consume: async () => {} })).rejects.toThrow('access token required');
    expect(f.calls).toHaveLength(0);
    f.setIdentityStatus(403);
    await expect(downloadProStablePackages({ cacheDir: f.cacheDir, apiBaseUrl: f.apiBaseUrl, accessToken: 'pro-token', resourceKeys: [f.selected.row.resourceKey], consume: async () => {} })).rejects.toThrow('403');
    expect(f.calls.some(call => call.path.includes('/root'))).toBe(false);
    expect(f.calls.some(call => call.path.includes('/packages/'))).toBe(false);
  } finally { await f.close(); }
});

it('warms only exact 128-WebP Pro tuple packages and reuses the private package cache', async () => {
  const f = await fixture();
  try {
    const context = {
      cwd: f.cacheDir,
      env: { MOEICONS_CACHE_DIR: f.cacheDir, MOEICONS_API_BASE_URL: f.apiBaseUrl },
      signal: new AbortController().signal,
      now: () => new Date('2026-10-17T00:00:00.000Z'),
      ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note: () => undefined, progress: () => ({ stop: () => undefined }) },
    };
    const auth = { tokenStore: tokenStore(proSession()) };
    f.calls.length = 0;
    const result = await runProPreviewPackageWarmupUseCase(context as never, auth, { fetch: globalThis.fetch.bind(globalThis) });
    expect(result).toMatchObject({ version: '1.0.0', groups: 1, packages: 1, downloaded: 1, reused: 0, networkBytes: f.preview.bytes.length });
    const payloadCalls = f.calls.filter(call => call.path.includes('/packages/'));
    expect(payloadCalls).toHaveLength(1);
    expect(payloadCalls[0]?.path).toContain(f.preview.row.packageSha256);
    expect(payloadCalls[0]?.authorization).toBe('Bearer pro-token');
    expect(f.calls.some(call => call.path.includes(f.selected.row.packageSha256) || call.path.includes(f.metadata.row.packageSha256))).toBe(false);
    const cache = join(f.cacheDir, 'small-pack-v1', 'pro');
    expect(fs.statSync(cache).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(cache, `${f.preview.row.packageSha256}.tgz`)).mode & 0o777).toBe(0o600);

    f.calls.length = 0;
    const warm = await runProPreviewPackageWarmupUseCase(context as never, auth, { fetch: globalThis.fetch.bind(globalThis) });
    expect(warm).toMatchObject({ downloaded: 0, reused: 1, networkBytes: 0 });
    expect(f.calls.some(call => call.path.includes('/packages/'))).toBe(false);
  } finally { await f.close(); }
});

it('routes production Pro install and package-set update through authenticated small units', async () => {
  const f = await fixture();
  const project = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-pro-small-install-'));
  try {
    fs.writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    const config = { schemaVersion: 3, tier: 'pro', target: 'react', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline', themes: { outline: { styleGroup: 'moe-pro-outline' } }, downloadMode: 'icons' };
    fs.writeFileSync(join(project, 'moeicons.config.json'), JSON.stringify(config));
    const session = proSession();
    const context = {
      cwd: project,
      env: { MOEICONS_API_BASE_URL: f.apiBaseUrl, MOEICONS_CACHE_DIR: f.cacheDir },
      signal: new AbortController().signal,
      now: () => new Date('2026-10-17T00:00:00.000Z'),
      ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note: () => undefined, progress: () => ({ stop: () => undefined }) },
    };
    const auth = { tokenStore: tokenStore(session) };
    const install = await runProInstallUseCase(context as never, {
      fs: transactionFs(), auth, fetch: globalThis.fetch.bind(globalThis),
    }, { target: 'react' });
    expect(install).toMatchObject({ artifactVersion: '1.0.0', downloadMode: 'packages', packageSetSha256: f.built.candidateSet.packageSetSha256 });
    expect(install).toMatchObject({ packageCount: 3, cacheHits: 0, metadataCacheHits: 0, transferRetryCount: 0 });
    expect(install.networkBytes).toBe(f.calls.reduce((sum, call) => sum + call.responseBytes, 0));
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname === '/v1/icon-library/pro/package-set' && new URL(call.path, f.apiBaseUrl).searchParams.get('version') === 'stable')).toHaveLength(1);
    expect(f.calls.filter(call => new URL(call.path, f.apiBaseUrl).pathname === '/v1/icon-library/pro/package-set' && new URL(call.path, f.apiBaseUrl).searchParams.get('version') === '1.0.0')).toHaveLength(1);
    process.stderr.write(`[network] Pro install: ${f.calls.length} GET attempts, ${install.packageCount} selected packages, ${install.networkBytes} response bytes\n`);
    expect(fs.existsSync(join(project, '.moeicons/artifact/react/moe-pro-outline/index.js'))).toBe(true);
    expect(fs.existsSync(join(project, '.moeicons-pro.marker'))).toBe(false);
    expect(fs.existsSync(join(project, 'src/icons/.moeicons-pro.marker'))).toBe(true);
    expect(readInstalledResourceState(project, 'pro').kind).toBe('ok');
    expect(f.calls.every(call => call.authorization === 'Bearer pro-token')).toBe(true);
    expect(f.calls.some(call => call.path.includes('/packages/'))).toBe(true);

    f.calls.length = 0;
    const out: string[] = [];
    const cliRuntime = {
      cwd: () => project,
      stdout: (value: string) => out.push(value),
      stderr: () => {},
      env: { MOEICONS_API_BASE_URL: f.apiBaseUrl, MOEICONS_CACHE_DIR: f.cacheDir },
      isTTY: () => false,
      auth: { tokenStore: tokenStore(session), fetch: globalThis.fetch.bind(globalThis) },
    };
    const updateStatus = await main(['update', '--json'], cliRuntime as never);
    expect(updateStatus).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, status: 'current', packageSetSha256: f.built.candidateSet.packageSetSha256 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.path).toBe('/v1/icon-library/pro/package-set?version=stable');
    expect(f.calls[0]?.authorization).toBe('Bearer pro-token');

    f.calls.length = 0;
    const update = await runLibraryUpdateUseCase(context as never, {
      fs: transactionFs(), auth, fetch: globalThis.fetch.bind(globalThis),
    }, {
      tier: 'pro', version: '1.0.0', descriptorSha256: f.built.candidateSet.packageSetSha256,
      packageSetSha256: f.built.candidateSet.packageSetSha256,
    });
    expect(update).toMatchObject({ artifactVersion: '1.0.0', downloadMode: 'packages' });
    expect(f.calls.some(call => call.path.startsWith('/v1/icon-library/pro/package-set?version=1.0.0&packageSetSha256='))).toBe(true);
    expect(f.calls.every(call => call.authorization === 'Bearer pro-token')).toBe(true);
    expect(readInstalledResourceState(project, 'pro').kind).toBe('ok');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    await f.close();
  }
});

it('refreshes Pro package metadata from the installed exact set without fetching code packages', async () => {
  const f = await fixture();
  const project = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-pro-metadata-refresh-'));
  const refreshCacheDir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'cli-pro-metadata-cache-'));
  try {
    fs.writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    fs.writeFileSync(join(project, 'moeicons.config.json'), JSON.stringify({ schemaVersion: 3, tier: 'pro', target: 'react', outputDir: 'src/icons', icons: ['sample'], defaultTheme: 'outline', themes: { outline: { styleGroup: 'moe-pro-outline' } }, downloadMode: 'icons' }));
    const context = {
      cwd: project,
      env: { MOEICONS_API_BASE_URL: f.apiBaseUrl, MOEICONS_CACHE_DIR: f.cacheDir },
      signal: new AbortController().signal,
      now: () => new Date('2026-10-17T00:00:00.000Z'),
      ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note: () => undefined, progress: () => ({ stop: () => undefined }) },
    };
    const session = proSession();
    const auth = { tokenStore: tokenStore(session) };
    const install = await runProInstallUseCase(context as never, {
      fs: transactionFs(), auth, fetch: globalThis.fetch.bind(globalThis),
    }, { target: 'react' });
    expect(install.downloadMode).toBe('packages');
    const codePath = join(project, '.moeicons/artifact/react/moe-pro-outline/index.js');
    const codeBefore = fs.readFileSync(codePath);
    fs.rmSync(join(project, '.moeicons/catalog.json'));
    fs.rmSync(join(project, '.moeicons/package-metadata/moe-pro-outline/catalog.json'));
    f.calls.length = 0;

    const refreshed = await runMetadataSyncUseCase({ ...context, env: { ...context.env, MOEICONS_CACHE_DIR: refreshCacheDir } } as never, {
      fs: transactionFs(), free: { cacheDir: refreshCacheDir } as never, auth,
      fetch: globalThis.fetch.bind(globalThis),
    });

    expect(refreshed).toMatchObject({ tier: 'pro', artifactVersion: '1.0.0', networkBytes: expect.any(Number) });
    expect(fs.existsSync(join(project, '.moeicons/catalog.json'))).toBe(true);
    expect(fs.existsSync(join(project, '.moeicons/package-metadata/moe-pro-outline/catalog.json'))).toBe(true);
    expect(fs.readFileSync(codePath)).toEqual(codeBefore);
    expect(readInstalledResourceState(project, 'pro').kind).toBe('ok');
    const packageRequests = f.calls.filter(call => call.path.includes('/packages/'));
    expect(packageRequests).toHaveLength(1);
    expect(packageRequests[0]?.path).toContain(f.metadata.row.packageSha256);
    expect(packageRequests[0]?.authorization).toBe('Bearer pro-token');
    expect(f.calls.every(call => call.authorization === 'Bearer pro-token')).toBe(true);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(refreshCacheDir, { recursive: true, force: true });
    await f.close();
  }
});
