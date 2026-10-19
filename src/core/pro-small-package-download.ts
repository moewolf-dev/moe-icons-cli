import * as fs from 'node:fs';
import { join } from 'node:path';
import { cacheArtifact, type CacheIo } from './cache.js';
import { downloadArtifact } from '../project/download.js';
import { parseCandidateSet, sha256, type PackageRow } from './small-pack/candidate-set.cjs';
import { readSelectedCandidate, consumeSelectedPackages, planSelectedPackages, verifySelectedPackage, type CandidateIdentity, type SelectedCandidate } from './small-package-selection.js';

const API_DEFAULT = 'https://api.moeicons.com';
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(?:0|[1-9]\d*))?)?$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Pro package download: ${message}`); }

function readPrivateCache(file: string, maximum: number, exact?: number): Uint8Array | undefined {
  let handle: number;
  try {
    const entry = fs.lstatSync(file);
    check(entry.isFile() && !entry.isSymbolicLink(), 'cached object must be a regular non-link file');
    if (process.platform !== 'win32') {
      check((entry.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || entry.uid === process.getuid()), 'Pro cache permissions or owner are unsafe');
    }
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(handle);
    check(stat.isFile() && stat.size > 0 && stat.size <= maximum && (exact === undefined || stat.size === exact), 'cached object size/type invalid');
    if (process.platform !== 'win32') check((stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'Pro cache permissions or owner changed');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) { const read = fs.readSync(handle, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
    check(count === stat.size, 'cache changed during bounded read');
    return bytes.subarray(0, count);
  } finally { fs.closeSync(handle); }
}

function privateCacheIo(): CacheIo {
  return {
    mkdirSync(path) {
      fs.mkdirSync(path, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(path, 0o700);
    },
    writeFileSync(path, bytes) { fs.writeFileSync(path, bytes, { mode: 0o600 }); },
    renameSync: fs.renameSync,
    existsSync: fs.existsSync,
    rmSync: fs.rmSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
  };
}

function resolveApiBase(value?: string): URL {
  const base = new URL(value ?? API_DEFAULT);
  const loopback = base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  check((base.protocol === 'https:' || loopback) && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'API base must be HTTPS or loopback HTTP');
  return base;
}

function authorizedFetch(fetchFn: typeof fetch, apiBase: URL, accessToken: string): typeof fetch {
  check(typeof accessToken === 'string' && accessToken.length > 0 && accessToken.length <= 8192 && !/[\r\n]/.test(accessToken), 'authenticated Pro access token required');
  return async (input, init) => {
    const address = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    if (new URL(address).origin !== apiBase.origin) throw new Error('Pro package download: refusing to send credentials outside the configured API origin');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Bearer ${accessToken}`);
    return await fetchFn(input, { ...init, headers });
  };
}

function identityUrl(apiBase: URL, version: string, packageSetSha256?: string): string {
  const url = new URL('/v1/icon-library/pro/package-set', apiBase);
  url.searchParams.set('version', version);
  if (packageSetSha256) url.searchParams.set('packageSetSha256', packageSetSha256);
  return url.href;
}

function assetUrl(apiBase: URL, identity: CandidateIdentity, path: string): string {
  const url = new URL(`/v1/icon-library/pro/package-set/${path}`, apiBase);
  url.searchParams.set('version', identity.fullVersion);
  url.searchParams.set('packageSetSha256', identity.packageSetSha256);
  return url.href;
}

export interface ProPackageSetIdentity extends CandidateIdentity {
  readonly schemaVersion: 1;
  readonly tier: 'pro';
  readonly candidateRootSha256: string;
  readonly candidateRootBytes: number;
  readonly updatedAt: string;
  readonly networkBytes: number;
}

export interface ProSmallPackageOptions {
  readonly expected: CandidateIdentity & { readonly tier: 'pro' };
  readonly resourceKeys?: readonly string[];
  readonly resolveResourceKeys?: (candidate: SelectedCandidate, loadVerifiedPackage: (row: PackageRow) => Promise<Readonly<Record<string, Uint8Array>>>) => Promise<readonly string[]>;
  readonly cacheDir: string;
  readonly consume: (row: PackageRow, files: Readonly<Record<string, Uint8Array>>) => Promise<void>;
  readonly accessToken: string;
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly expectedRootSha256?: string;
  readonly expectedRootBytes?: number;
}

export async function fetchProPackageSetIdentity(options: {
  readonly version: string;
  readonly packageSetSha256?: string;
  readonly accessToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<ProPackageSetIdentity> {
  check(options.version === 'stable' || VERSION.test(options.version), 'requested Pro version is invalid');
  if (options.version === 'stable') check(options.packageSetSha256 === undefined, 'stable lookup cannot include a package-set digest');
  else check(SHA.test(options.packageSetSha256 ?? ''), 'exact Pro version lookup requires a package-set digest');
  const apiBase = resolveApiBase(options.apiBaseUrl);
  const fetchFn = authorizedFetch(options.fetchFn ?? globalThis.fetch, apiBase, options.accessToken);
  const result = await downloadArtifact(identityUrl(apiBase, options.version, options.packageSetSha256), {
    maxBytes: 16 * 1024,
    timeoutMs: 120000,
    maxRedirects: 0,
    allowedHosts: [apiBase.host],
    ...(apiBase.protocol === 'http:' ? { allowHttpLoopback: true } : {}),
    userAgent: 'moeicons/small-package',
  }, { fetchFn, ...(options.signal ? { signal: options.signal } : {}) });
  if (!result.ok) throw new Error(`Pro package-set identity: ${result.code}: ${result.message}`);
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(result.bytes).toString('utf8')); } catch { throw new Error('Pro package-set identity: invalid JSON'); }
  check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'identity object required');
  const value = raw as Record<string, unknown>;
  const fields = ['schemaVersion', 'tier', 'fullVersion', 'sourceCommit', 'generatorCommit', 'packageSetSha256', 'candidateRootSha256', 'candidateRootBytes', 'updatedAt'];
  check(Object.keys(value).sort().join(',') === [...fields].sort().join(','), 'identity fields differ from the Pro package-set contract');
  check(value.schemaVersion === 1 && value.tier === 'pro' && typeof value.fullVersion === 'string' && VERSION.test(value.fullVersion), 'Pro version identity invalid');
  check(options.version === 'stable' || value.fullVersion === options.version, 'identity version differs from request');
  check(typeof value.sourceCommit === 'string' && COMMIT.test(value.sourceCommit), 'Source commit invalid');
  check(typeof value.generatorCommit === 'string' && COMMIT.test(value.generatorCommit), 'Generator commit invalid');
  check(typeof value.packageSetSha256 === 'string' && SHA.test(value.packageSetSha256), 'package-set digest invalid');
  check(options.packageSetSha256 === undefined || value.packageSetSha256 === options.packageSetSha256, 'identity package-set digest differs from request');
  check(typeof value.candidateRootSha256 === 'string' && SHA.test(value.candidateRootSha256), 'candidate root digest invalid');
  check(Number.isSafeInteger(value.candidateRootBytes) && Number(value.candidateRootBytes) > 0 && Number(value.candidateRootBytes) <= 1024 ** 2, 'candidate root size invalid');
  check(typeof value.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.updatedAt) && !Number.isNaN(Date.parse(value.updatedAt)), 'identity timestamp invalid');
  return { ...value, networkBytes: result.bytes.length } as ProPackageSetIdentity;
}

export async function fetchProStablePackageSet(options: Omit<Parameters<typeof fetchProPackageSetIdentity>[0], 'version' | 'packageSetSha256'>): Promise<ProPackageSetIdentity> {
  return fetchProPackageSetIdentity({ ...options, version: 'stable' });
}

export async function downloadProSelectedPackages(options: ProSmallPackageOptions): Promise<{ packageCount: number; networkBytes: number; cacheHits: number; metadataNetworkBytes: number; metadataCacheHits: number; transferRetryCount: number }> {
  options.signal?.throwIfAborted();
  check((options.resourceKeys !== undefined) !== (options.resolveResourceKeys !== undefined), 'provide exactly one explicit selection or candidate-based planner');
  if (options.resourceKeys) check(options.resourceKeys.length > 0 && new Set(options.resourceKeys).size === options.resourceKeys.length, 'explicit unique resource selection required');
  const expected = options.expected;
  check(expected.tier === 'pro' && SHA.test(expected.packageSetSha256) && COMMIT.test(expected.sourceCommit) && COMMIT.test(expected.generatorCommit) && VERSION.test(expected.fullVersion), 'exact Pro candidate pin required');
  if (options.expectedRootSha256 !== undefined) check(SHA.test(options.expectedRootSha256), 'candidate root pin must be lowercase SHA-256');
  if (options.expectedRootBytes !== undefined) check(Number.isSafeInteger(options.expectedRootBytes) && options.expectedRootBytes > 0 && options.expectedRootBytes <= 1024 ** 2, 'candidate root byte pin is invalid');
  const apiBase = resolveApiBase(options.apiBaseUrl);
  const fetchFn = authorizedFetch(options.fetchFn ?? globalThis.fetch, apiBase, options.accessToken);
  let transferRetryCount = 0;
  const fetchBytes = async (address: string, maximum: number): Promise<Uint8Array> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      options.signal?.throwIfAborted();
      const result = await downloadArtifact(address, {
        maxBytes: maximum,
        timeoutMs: 120000,
        maxRedirects: 0,
        allowedHosts: [apiBase.host],
        ...(apiBase.protocol === 'http:' ? { allowHttpLoopback: true } : {}),
        userAgent: 'moeicons/small-package',
      }, { fetchFn, ...(options.signal ? { signal: options.signal } : {}) });
      if (result.ok) return result.bytes;
      const transient = result.code === 'NETWORK_ERROR' || result.code === 'HTTP_ERROR' && /\b(?:429|500|502|503|504)\b/.test(result.message);
      if (!transient || attempt === 2) throw new Error(`Pro package download: ${result.code}: ${result.message}`);
      transferRetryCount++;
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); reject(new Error('Pro package download cancelled')); };
        const timer = setTimeout(() => { options.signal?.removeEventListener('abort', aborted); resolve(); }, 250 * (attempt + 1));
        options.signal?.addEventListener('abort', aborted, { once: true });
        if (options.signal?.aborted) aborted();
      });
    }
    throw new Error('Pro package download retry budget exhausted');
  };
  const cache = join(options.cacheDir, 'small-pack-v1', 'pro');
  const io = privateCacheIo();
  const persist = (name: string, bytes: Uint8Array, digest: string): void => cacheArtifact(io, join(cache, name), bytes, digest);
  const rootName = `candidate-set-${expected.packageSetSha256}.json`;
  let metadataNetworkBytes = 0;
  let metadataCacheHits = 0;
  let rootBytes = readPrivateCache(join(cache, rootName), 1024 ** 2);
  const rootCached = rootBytes !== undefined;
  if (rootBytes) metadataCacheHits++;
  else { rootBytes = await fetchBytes(assetUrl(apiBase, expected, 'root'), 1024 ** 2); metadataNetworkBytes += rootBytes.length; }
  if (options.expectedRootSha256) check(sha256(rootBytes) === options.expectedRootSha256, 'candidate root differs from authenticated identity');
  if (options.expectedRootBytes !== undefined) check(rootBytes.length === options.expectedRootBytes, 'candidate root size differs from authenticated identity');
  const root = parseCandidateSet(rootBytes);
  for (const key of ['fullVersion', 'tier', 'sourceCommit', 'generatorCommit', 'packageSetSha256'] as const) check(root[key] === expected[key], 'root differs from authenticated Pro identity');
  const pending: Array<{ name: string; bytes: Uint8Array; digest: string }> = [];
  const candidate = await readSelectedCandidate(rootBytes, expected, async ref => {
    const name = `page-${ref.sha256}.json`;
    let bytes = readPrivateCache(join(cache, name), ref.sizeBytes, ref.sizeBytes);
    if (bytes) metadataCacheHits++;
    else {
      const index = root.packagePages.findIndex(item => item.filename === ref.filename && item.sha256 === ref.sha256) + 1;
      check(index > 0, 'page reference is outside the verified root');
      bytes = await fetchBytes(assetUrl(apiBase, expected, `pages/${index}`), ref.sizeBytes);
      metadataNetworkBytes += bytes.length;
      pending.push({ name, bytes, digest: ref.sha256 });
    }
    return bytes;
  });
  if (!rootCached) persist(rootName, rootBytes, sha256(rootBytes));
  for (const page of pending) persist(page.name, page.bytes, page.digest);

  let bootstrapNetworkBytes = 0;
  const prefetched = new Map<string, { bytes: Uint8Array; network: boolean }>();
  const loadVerifiedPackage = async (row: PackageRow): Promise<Readonly<Record<string, Uint8Array>>> => {
    const trusted = candidate.rows.find(item => item.resourceKey === row.resourceKey);
    check(trusted && trusted.packageSha256 === row.packageSha256 && trusted.compressedBytes === row.compressedBytes, 'bootstrap package is outside the exact candidate rows');
    const path = join(cache, `${row.packageSha256}.tgz`);
    const cached = readPrivateCache(path, row.compressedBytes, row.compressedBytes);
    const bytes = cached ?? await fetchBytes(assetUrl(apiBase, expected, `packages/${row.packageSha256}.tgz`), row.compressedBytes);
    const files = verifySelectedPackage(trusted, bytes);
    if (!cached) { bootstrapNetworkBytes += bytes.length; persist(`${row.packageSha256}.tgz`, bytes, row.packageSha256); }
    prefetched.set(row.packageSha256, { bytes, network: !cached });
    return files;
  };
  const resourceKeys = options.resolveResourceKeys
    ? await options.resolveResourceKeys(candidate, loadVerifiedPackage)
    : options.resourceKeys;
  check(resourceKeys && resourceKeys.length > 0 && new Set(resourceKeys).size === resourceKeys.length, 'candidate planner must return explicit unique resource keys');
  const selectedRows = planSelectedPackages(candidate, resourceKeys);
  const prefetchedNetworkDigests = new Set([...prefetched].filter(([, value]) => value.network).map(([digest]) => digest));
  const report = await consumeSelectedPackages(candidate, resourceKeys, {
    readCache: row => Promise.resolve(prefetched.get(row.packageSha256)?.bytes ?? readPrivateCache(join(cache, `${row.packageSha256}.tgz`), row.compressedBytes, row.compressedBytes)),
    writeCache: (row, bytes) => { persist(`${row.packageSha256}.tgz`, bytes, row.packageSha256); return Promise.resolve(); },
    download: row => fetchBytes(assetUrl(apiBase, expected, `packages/${row.packageSha256}.tgz`), row.compressedBytes),
    consume: options.consume,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const prefetchedSelectedNetworkCount = selectedRows.filter(row => prefetchedNetworkDigests.has(row.packageSha256)).length;
  return {
    ...report,
    networkBytes: report.networkBytes + bootstrapNetworkBytes,
    cacheHits: report.cacheHits - prefetchedSelectedNetworkCount,
    metadataNetworkBytes,
    metadataCacheHits,
    transferRetryCount,
  };
}

export async function downloadProStablePackages(options: Omit<ProSmallPackageOptions, 'expected' | 'expectedRootSha256' | 'expectedRootBytes'>): Promise<{ packageCount: number; networkBytes: number; cacheHits: number; metadataNetworkBytes: number; metadataCacheHits: number; transferRetryCount: number }> {
  const identity = await fetchProStablePackageSet({
    accessToken: options.accessToken,
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const { accessToken, apiBaseUrl, fetchFn, signal, ...rest } = options;
  const report = await downloadProSelectedPackages({
    ...rest,
    accessToken,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(fetchFn ? { fetchFn } : {}),
    ...(signal ? { signal } : {}),
    expected: identity,
    expectedRootSha256: identity.candidateRootSha256,
    expectedRootBytes: identity.candidateRootBytes,
  });
  return { ...report, metadataNetworkBytes: report.metadataNetworkBytes + identity.networkBytes };
}

export async function downloadProVersionPackages(options: Omit<ProSmallPackageOptions, 'expected' | 'expectedRootSha256' | 'expectedRootBytes'> & { readonly fullVersion: string; readonly expectedPackageSetSha256: string }): Promise<{ packageCount: number; networkBytes: number; cacheHits: number; metadataNetworkBytes: number; metadataCacheHits: number; transferRetryCount: number }> {
  check(VERSION.test(options.fullVersion) && SHA.test(options.expectedPackageSetSha256), 'exact Pro version and package-set pin required');
  const identity = await fetchProPackageSetIdentity({
    version: options.fullVersion,
    packageSetSha256: options.expectedPackageSetSha256,
    accessToken: options.accessToken,
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const report = await downloadProSelectedPackages({
    cacheDir: options.cacheDir,
    ...(options.resourceKeys ? { resourceKeys: options.resourceKeys } : {}),
    ...(options.resolveResourceKeys ? { resolveResourceKeys: options.resolveResourceKeys } : {}),
    consume: options.consume,
    accessToken: options.accessToken,
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    expected: identity,
    expectedRootSha256: identity.candidateRootSha256,
    expectedRootBytes: identity.candidateRootBytes,
  });
  return { ...report, metadataNetworkBytes: report.metadataNetworkBytes + identity.networkBytes };
}
