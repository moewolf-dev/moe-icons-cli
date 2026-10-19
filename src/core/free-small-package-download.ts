import * as fs from 'node:fs';
import { join } from 'node:path';
import { cacheArtifact } from './cache.js';
import { downloadArtifact } from '../project/download.js';
import { FREE_DOWNLOAD_HOSTS, githubReleaseAssetUrl } from './release-descriptor.js';
import { parseCandidateSet, sha256, type PackageRow } from './small-pack/candidate-set.cjs';
import { readSelectedCandidate, consumeSelectedPackages, planSelectedPackages, verifySelectedPackage, type CandidateIdentity, type SelectedCandidate } from './small-package-selection.js';
import { parseFreeCandidateVersionPointer } from './candidate-version-pointer.js';

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Free package download: ${message}`); }
function readCache(file: string, maximum: number, exact?: number): Uint8Array | undefined {
  let handle: number;
  try {
    const entry = fs.lstatSync(file); check(entry.isFile() && !entry.isSymbolicLink(), 'cached object must be a regular non-link file');
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fs.fstatSync(handle); check(stat.isFile() && stat.size > 0 && stat.size <= maximum && (exact === undefined || stat.size === exact), 'cached object size/type invalid');
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const read = fs.readSync(handle, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
    check(count === stat.size, 'cache changed during bounded read'); return bytes.subarray(0, count);
  } finally { fs.closeSync(handle); }
}
export interface FreeSmallPackageOptions {
  expected: CandidateIdentity;
  resourceKeys?: readonly string[];
  resolveResourceKeys?: (candidate: SelectedCandidate, loadVerifiedPackage: (row: PackageRow) => Promise<Readonly<Record<string, Uint8Array>>>) => Promise<readonly string[]>;
  cacheDir: string;
  consume: (row: PackageRow, files: Readonly<Record<string, Uint8Array>>) => Promise<void>;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** Explicit loopback fixture origin, never a published remote override. */
  fixtureOrigin?: string;
  /** Bound by a public immutable version pointer when resolving by version. */
  expectedRootSha256?: string;
  expectedRootBytes?: number;
  /** Public Worker API base; production defaults to https://api.moeicons.com. */
  apiBaseUrl?: string;
}
export async function downloadFreeSelectedPackages(options: FreeSmallPackageOptions): Promise<{ packageCount: number; networkBytes: number; cacheHits: number; metadataNetworkBytes: number; metadataCacheHits: number; transferRetryCount: number }> {
  options.signal?.throwIfAborted();
  check((options.resourceKeys !== undefined) !== (options.resolveResourceKeys !== undefined), 'provide exactly one explicit selection or candidate-based planner');
  if (options.resourceKeys) check(options.resourceKeys.length > 0 && new Set(options.resourceKeys).size === options.resourceKeys.length, 'explicit unique resource selection required');
  const expected = options.expected;
  check(expected.tier === 'free' && /^[a-f0-9]{64}$/.test(expected.packageSetSha256) && /^[a-f0-9]{40}$/.test(expected.sourceCommit) && /^[a-f0-9]{40}$/.test(expected.generatorCommit) && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(?:0|[1-9]\d*))?)?$/.test(expected.fullVersion), 'exact Free candidate pin required');
  if (options.expectedRootSha256 !== undefined) check(/^[a-f0-9]{64}$/.test(options.expectedRootSha256), 'candidate root pin must be lowercase SHA-256');
  if (options.expectedRootBytes !== undefined) check(Number.isSafeInteger(options.expectedRootBytes) && options.expectedRootBytes > 0 && options.expectedRootBytes <= 1024 ** 2, 'candidate root byte pin is invalid');
  let fixture: URL | undefined;
  if (options.fixtureOrigin) {
    fixture = new URL(options.fixtureOrigin);
    check(fixture.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname) && !fixture.username && !fixture.password && !fixture.search && !fixture.hash && fixture.pathname === '/', 'fixture must be an explicit loopback origin');
  }
  const apiBase = resolveFreeApiBase(options.apiBaseUrl, fixture);
  const url = (tag: string, filename: string): string => fixture ? new URL(`/moewolf-dev/moe-icons/releases/download/${tag}/${filename}`, fixture).href : githubReleaseAssetUrl(tag, filename);
  let transferRetryCount = 0;
  const fetchBytes = async (address: string, maximum: number): Promise<Uint8Array> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      options.signal?.throwIfAborted();
      const result = await downloadArtifact(address, { maxBytes: maximum, timeoutMs: 120000, maxRedirects: 3, allowedHosts: fixture ? [fixture.host] : apiBase.protocol === 'http:' ? [apiBase.host] : [...FREE_DOWNLOAD_HOSTS, apiBase.host], ...(fixture || apiBase.protocol === 'http:' ? { allowHttpLoopback: true } : {}), userAgent: 'moeicons/small-package' }, { ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      if (result.ok) return result.bytes;
      const transient = result.code === 'NETWORK_ERROR' || result.code === 'HTTP_ERROR' && /\b(?:429|500|502|503|504)\b/.test(result.message);
      if (!transient || attempt === 2) throw new Error(`Free package download: ${result.code}: ${result.message}`);
      transferRetryCount++;
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); reject(new Error('Free package download cancelled')); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', aborted); resolve(); }, 250 * (attempt + 1));
        options.signal?.addEventListener('abort', aborted, { once: true });
        if (options.signal?.aborted) aborted();
      });
    }
    throw new Error('Free package download retry budget exhausted');
  };
  const cache = join(options.cacheDir, 'small-pack-v1', 'free');
  const io = { mkdirSync: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); }, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, existsSync: fs.existsSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  const persist = (name: string, bytes: Uint8Array, digest: string): void => cacheArtifact(io, join(cache, name), bytes, digest);
  const tag = `candidate-set-v1-free-${expected.packageSetSha256}`;
  const rootName = `candidate-set-${expected.packageSetSha256}.json`;
  let metadataNetworkBytes = 0, metadataCacheHits = 0;
  let rootBytes = readCache(join(cache, rootName), 1024 ** 2);
  const rootCached = rootBytes !== undefined;
  if (rootBytes) metadataCacheHits++; else {
    const address = fixture ? url(tag, 'candidate-set-free.json') : freePackageSetAssetUrl(apiBase, expected, 'root');
    rootBytes = await fetchBytes(address, 1024 ** 2); metadataNetworkBytes += rootBytes.length;
  }
  if (options.expectedRootSha256) check(sha256(rootBytes) === options.expectedRootSha256, 'candidate root differs from immutable version pointer');
  if (options.expectedRootBytes !== undefined) check(rootBytes.length === options.expectedRootBytes, 'candidate root size differs from immutable identity');
  const root = parseCandidateSet(rootBytes);
  // Reject identity drift before any page request or cache write.
  for (const key of ['fullVersion', 'tier', 'sourceCommit', 'generatorCommit', 'packageSetSha256'] as const) check(root[key] === expected[key], 'root differs from pinned Free identity');
  const pending: Array<{ name: string; bytes: Uint8Array; digest: string }> = [];
  const candidate = await readSelectedCandidate(rootBytes, expected, async ref => {
    const name = `page-${ref.sha256}.json`; let bytes = readCache(join(cache, name), ref.sizeBytes, ref.sizeBytes);
    if (bytes) metadataCacheHits++; else {
      const index = root.packagePages.findIndex((item) => item.filename === ref.filename && item.sha256 === ref.sha256) + 1;
      check(index > 0, 'page reference is not in the verified root');
      const address = fixture ? url(tag, ref.filename) : freePackageSetAssetUrl(apiBase, expected, `pages/${index}`);
      bytes = await fetchBytes(address, ref.sizeBytes); metadataNetworkBytes += bytes.length; pending.push({ name, bytes, digest: ref.sha256 });
    }
    return bytes;
  });
  if (!rootCached) persist(rootName, rootBytes, sha256(rootBytes));
  for (const page of pending) persist(page.name, page.bytes, page.digest);
  let bootstrapNetworkBytes = 0;
  const prefetched = new Map<string, { bytes: Uint8Array; row: PackageRow; network: boolean }>();
  const loadVerifiedPackage = async (row: PackageRow): Promise<Readonly<Record<string, Uint8Array>>> => {
    const trusted = candidate.rows.find(item => item.resourceKey === row.resourceKey);
    check(trusted && trusted.packageSha256 === row.packageSha256 && trusted.compressedBytes === row.compressedBytes, 'bootstrap package is outside exact candidate rows');
    const cached = readCache(join(cache, `${row.packageSha256}.tgz`), row.compressedBytes, row.compressedBytes);
    const address = fixture ? url(`free-package-v1-${row.packageSha256}`, `${row.packageSha256}.tgz`) : freePackageSetAssetUrl(apiBase, expected, `packages/${row.packageSha256}.tgz`);
    const bytes = cached ?? await fetchBytes(address, row.compressedBytes);
    const files = verifySelectedPackage(trusted, bytes);
    if (!cached) { bootstrapNetworkBytes += bytes.length; persist(`${row.packageSha256}.tgz`, bytes, row.packageSha256); }
    prefetched.set(row.packageSha256, { bytes, row: trusted, network: !cached });
    return files;
  };
  const resourceKeys = options.resolveResourceKeys
    ? await options.resolveResourceKeys(candidate, loadVerifiedPackage)
    : options.resourceKeys;
  check(resourceKeys && resourceKeys.length > 0 && new Set(resourceKeys).size === resourceKeys.length, 'candidate planner must return explicit unique resource keys');
  const selectedRows = planSelectedPackages(candidate, resourceKeys);
  const prefetchedNetworkDigests = new Set([...prefetched].filter(([, value]) => value.network).map(([digest]) => digest));
  const report = await consumeSelectedPackages(candidate, resourceKeys, {
    readCache: row => Promise.resolve(prefetched.get(row.packageSha256)?.bytes ?? readCache(join(cache, `${row.packageSha256}.tgz`), row.compressedBytes, row.compressedBytes)),
    writeCache: (row, bytes) => { persist(`${row.packageSha256}.tgz`, bytes, row.packageSha256); return Promise.resolve(); },
    download: row => fetchBytes(fixture ? url(`free-package-v1-${row.packageSha256}`, `${row.packageSha256}.tgz`) : freePackageSetAssetUrl(apiBase, expected, `packages/${row.packageSha256}.tgz`), row.compressedBytes),
    consume: options.consume,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const prefetchedSelectedNetworkCount = selectedRows.filter(row => prefetchedNetworkDigests.has(row.packageSha256)).length;
  return { ...report, networkBytes: report.networkBytes + bootstrapNetworkBytes, cacheHits: report.cacheHits - prefetchedSelectedNetworkCount, metadataNetworkBytes, metadataCacheHits, transferRetryCount };
}

export interface FreeSmallPackageVersionOptions extends Omit<FreeSmallPackageOptions, 'expected' | 'expectedRootSha256' | 'expectedRootBytes'> {
  fullVersion: string;
  expectedPackageSetSha256?: string;
}

/** Resolve a version through its immutable public pointer, then use the same
 * exact-pin package reader. The pointer is cached only after the candidate
 * root and all requested units have passed verification. */
export async function downloadFreeVersionPackages(options: FreeSmallPackageVersionOptions): Promise<{ packageCount: number; networkBytes: number; cacheHits: number; metadataNetworkBytes: number; metadataCacheHits: number; transferRetryCount: number }> {
  options.signal?.throwIfAborted();
  check((options.resourceKeys !== undefined) !== (options.resolveResourceKeys !== undefined), 'provide exactly one explicit selection or candidate-based planner');
  if (options.resourceKeys) check(options.resourceKeys.length > 0 && new Set(options.resourceKeys).size === options.resourceKeys.length, 'explicit unique resource selection required');
  check(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(?:0|[1-9]\d*))?)?$/.test(options.fullVersion), 'exact Free version required');
  let fixture: URL | undefined;
  if (options.fixtureOrigin) {
    fixture = new URL(options.fixtureOrigin);
    check(fixture.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname) && !fixture.username && !fixture.password && !fixture.search && !fixture.hash && fixture.pathname === '/', 'fixture must be an explicit loopback origin');
  }
  const cache = join(options.cacheDir, 'small-pack-v1', 'free');
  const apiBase = resolveFreeApiBase(options.apiBaseUrl, fixture);
  if (options.expectedPackageSetSha256 !== undefined) {
    check(/^[a-f0-9]{64}$/.test(options.expectedPackageSetSha256), 'expected package-set digest must be lowercase SHA-256');
    const identity = await fetchFreePackageSetIdentity({
      version: options.fullVersion,
      packageSetSha256: options.expectedPackageSetSha256,
      apiBase,
      ...(fixture ? { fixture } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const downloadOptions: FreeSmallPackageOptions = {
      expected: identity,
      cacheDir: options.cacheDir,
      ...(options.resourceKeys ? { resourceKeys: options.resourceKeys } : {}),
      ...(options.resolveResourceKeys ? { resolveResourceKeys: options.resolveResourceKeys } : {}),
      consume: options.consume,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.fixtureOrigin ? { fixtureOrigin: options.fixtureOrigin } : {}),
      ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
      expectedRootSha256: identity.candidateRootSha256,
      expectedRootBytes: identity.candidateRootBytes,
    };
    const report = await downloadFreeSelectedPackages({
      ...downloadOptions,
    });
    return { ...report, metadataNetworkBytes: report.metadataNetworkBytes + identity.networkBytes, metadataCacheHits: report.metadataCacheHits };
  }
  const pointerFile = join(cache, `version-${options.fullVersion}.json`);
  let pointerBytes = readCache(pointerFile, 16 * 1024);
  const pointerCached = pointerBytes !== undefined;
  if (!pointerBytes) {
    const tag = `candidate-version-v1-free-${options.fullVersion}`;
    const address = fixture
      ? new URL(`/moewolf-dev/moe-icons/releases/download/${tag}/candidate-version-free.json`, fixture).href
      : githubReleaseAssetUrl(tag, 'candidate-version-free.json');
    for (let attempt = 0; attempt < 3; attempt++) {
      options.signal?.throwIfAborted();
      const result = await downloadArtifact(address, {
        maxBytes: 16 * 1024,
        timeoutMs: 120000,
        maxRedirects: 3,
        allowedHosts: fixture ? [fixture.host] : FREE_DOWNLOAD_HOSTS,
        ...(fixture ? { allowHttpLoopback: true } : {}),
        userAgent: 'moeicons/small-package',
      }, { ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      if (result.ok) { pointerBytes = result.bytes; break; }
      const transient = result.code === 'NETWORK_ERROR' || result.code === 'HTTP_ERROR' && /\b(?:429|500|502|503|504)\b/.test(result.message);
      if (!transient || attempt === 2) throw new Error(`Free candidate version pointer: ${result.code}: ${result.message}`);
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); reject(new Error('Free package download cancelled')); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', aborted); resolve(); }, 250 * (attempt + 1));
        options.signal?.addEventListener('abort', aborted, { once: true });
        if (options.signal?.aborted) aborted();
      });
    }
  }
  check(pointerBytes, 'version pointer download returned no bytes');
  const pointer = parseFreeCandidateVersionPointer(pointerBytes, options.fullVersion);
  const { fullVersion, ...downloadOptions } = options;
  const report = await downloadFreeSelectedPackages({
    ...downloadOptions,
    expected: {
      fullVersion,
      tier: 'free',
      sourceCommit: pointer.sourceCommit,
      generatorCommit: pointer.generatorCommit,
      packageSetSha256: pointer.packageSetSha256,
    },
    expectedRootSha256: pointer.candidateRootSha256,
    expectedRootBytes: pointer.candidateRootBytes,
  });
  if (!pointerCached) {
    const io = { mkdirSync: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); }, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, existsSync: fs.existsSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
    cacheArtifact(io, pointerFile, pointerBytes, sha256(pointerBytes));
  }
  return {
    ...report,
    metadataNetworkBytes: report.metadataNetworkBytes + (pointerCached ? 0 : pointerBytes.length),
    metadataCacheHits: report.metadataCacheHits + (pointerCached ? 1 : 0),
  };
}

export interface FreePackageSetIdentity {
  readonly schemaVersion: 1;
  readonly tier: 'free';
  readonly fullVersion: string;
  readonly sourceCommit: string;
  readonly generatorCommit: string;
  readonly packageSetSha256: string;
  readonly candidateRootSha256: string;
  readonly candidateRootBytes: number;
  readonly updatedAt: string;
  readonly networkBytes: number;
}

const FREE_API_DEFAULT = 'https://api.moeicons.com';
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(?:0|[1-9]\d*))?)?$/;

function resolveFreeApiBase(value: string | undefined, fixture: URL | undefined): URL {
  const base = new URL(value ?? fixture?.origin ?? FREE_API_DEFAULT);
  const loopback = base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  check((base.protocol === 'https:' || loopback) && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'API base must be HTTPS or an explicit loopback origin');
  return base;
}

function freePackageSetApiUrl(apiBase: URL, query: URLSearchParams): string {
  const url = new URL('/v1/icon-library/free/package-set', apiBase);
  url.search = query.toString();
  return url.href;
}

function freePackageSetAssetUrl(apiBase: URL, identity: CandidateIdentity, path: string): string {
  const url = new URL(`/v1/icon-library/free/package-set/${path}`, apiBase);
  url.searchParams.set('version', identity.fullVersion);
  url.searchParams.set('packageSetSha256', identity.packageSetSha256);
  return url.href;
}

async function fetchFreePackageSetIdentity(input: {
  version: string;
  packageSetSha256?: string;
  apiBase: URL;
  fixture?: URL;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<FreePackageSetIdentity> {
  const query = new URLSearchParams({ version: input.version });
  if (input.packageSetSha256) query.set('packageSetSha256', input.packageSetSha256);
  let address: string;
  if (input.fixture) {
    address = input.version === 'stable'
      ? new URL('/v1/icon-library/free/package-set?version=stable', input.fixture).href
      : new URL(`/v1/icon-library/free/package-set?version=${encodeURIComponent(input.version)}&packageSetSha256=${encodeURIComponent(input.packageSetSha256 ?? '')}`, input.fixture).href;
  } else address = freePackageSetApiUrl(input.apiBase, query);
  const result = await downloadArtifact(address, {
    maxBytes: 16 * 1024,
    timeoutMs: 120000,
    maxRedirects: 0,
    allowedHosts: input.fixture ? [input.fixture.host] : [input.apiBase.host],
    ...(input.fixture || input.apiBase.protocol === 'http:' ? { allowHttpLoopback: true } : {}),
    userAgent: 'moeicons/small-package',
  }, { ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  if (!result.ok) throw new Error(`Free package-set identity: ${result.code}: ${result.message}`);
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(result.bytes).toString('utf8')); } catch { throw new Error('Free package-set identity: invalid JSON'); }
  check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'identity object required');
  const value = raw as Record<string, unknown>;
  const keys = ['schemaVersion', 'tier', 'fullVersion', 'sourceCommit', 'generatorCommit', 'packageSetSha256', 'candidateRootSha256', 'candidateRootBytes', 'updatedAt'];
  check(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'identity fields differ from the Free package-set contract');
  check(value.schemaVersion === 1 && value.tier === 'free' && typeof value.fullVersion === 'string' && VERSION_PATTERN.test(value.fullVersion), 'Free version identity invalid');
  check(input.version === 'stable' || value.fullVersion === input.version, 'identity version differs from request');
  check(typeof value.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(value.sourceCommit), 'Source commit invalid');
  check(typeof value.generatorCommit === 'string' && /^[a-f0-9]{40}$/.test(value.generatorCommit), 'Generator commit invalid');
  check(typeof value.packageSetSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.packageSetSha256), 'package-set digest invalid');
  check(input.packageSetSha256 === undefined || value.packageSetSha256 === input.packageSetSha256, 'identity package-set digest differs from request');
  check(typeof value.candidateRootSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.candidateRootSha256), 'candidate root digest invalid');
  check(Number.isSafeInteger(value.candidateRootBytes) && Number(value.candidateRootBytes) > 0 && Number(value.candidateRootBytes) <= 1024 ** 2, 'candidate root size invalid');
  check(typeof value.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.updatedAt) && !Number.isNaN(Date.parse(value.updatedAt)), 'identity update timestamp invalid');
  return { ...value, networkBytes: result.bytes.length } as FreePackageSetIdentity;
}

export async function fetchFreeStablePackageSet(options: {
  apiBaseUrl?: string;
  fixtureOrigin?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
} = {}): Promise<FreePackageSetIdentity> {
  let fixture: URL | undefined;
  if (options.fixtureOrigin) {
    fixture = new URL(options.fixtureOrigin);
    check(fixture.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname) && !fixture.username && !fixture.password && !fixture.search && !fixture.hash && fixture.pathname === '/', 'fixture must be an explicit loopback origin');
  }
  const apiBase = resolveFreeApiBase(options.apiBaseUrl, fixture);
  return fetchFreePackageSetIdentity({ version: 'stable', apiBase, ...(fixture ? { fixture } : {}), ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}), ...(options.signal ? { signal: options.signal } : {}) });
}

export async function downloadFreeStablePackages(options: Omit<FreeSmallPackageOptions, 'expected' | 'expectedRootSha256' | 'expectedRootBytes'>): Promise<{ packageCount: number; networkBytes: number; cacheHits: number; metadataNetworkBytes: number; metadataCacheHits: number; transferRetryCount: number }> {
  const identity = await fetchFreeStablePackageSet({ ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}), ...(options.fixtureOrigin ? { fixtureOrigin: options.fixtureOrigin } : {}), ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  const { apiBaseUrl, fixtureOrigin, fetchFn, signal, ...rest } = options;
  const report = await downloadFreeSelectedPackages({
    ...rest,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(fixtureOrigin ? { fixtureOrigin } : {}),
    ...(fetchFn ? { fetchFn } : {}),
    ...(signal ? { signal } : {}),
    expected: identity,
    expectedRootSha256: identity.candidateRootSha256,
    expectedRootBytes: identity.candidateRootBytes,
  });
  return { ...report, metadataNetworkBytes: report.metadataNetworkBytes + identity.networkBytes };
}
