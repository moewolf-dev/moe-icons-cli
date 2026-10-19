import { gunzipSync } from 'node:zlib';
import { canonicalBytes, sha256, parseCandidateSet, validatePackagePages, verifyPackagePayload, type CandidateRoot, type PackageRow, type PageRef } from './small-pack/candidate-set.cjs';
import { readTarEntries } from './small-pack/tar-read.cjs';

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`small-package selection: ${message}`); }
export interface CandidateIdentity { fullVersion: string; tier: 'free' | 'pro'; sourceCommit: string; generatorCommit: string; packageSetSha256: string }
export interface SelectedCandidate { readonly root: CandidateRoot; readonly rows: readonly PackageRow[] }
export async function readSelectedCandidate(rootBytes: Uint8Array, expected: CandidateIdentity, readPage: (ref: PageRef) => Promise<Uint8Array>): Promise<SelectedCandidate> {
  const root = parseCandidateSet(rootBytes);
  for (const key of ['fullVersion', 'tier', 'sourceCommit', 'generatorCommit', 'packageSetSha256'] as const) check(root[key] === expected[key], `candidate ${key} differs from exact pin`);
  check(root.packagePages.reduce((sum, ref) => sum + ref.sizeBytes, 0) <= 16 * 1024 ** 2, 'metadata exceeds 16 MiB budget');
  const pages = new Map<string, Uint8Array>();
  for (const ref of root.packagePages) pages.set(ref.filename, await readPage({ ...ref }));
  return { root, rows: validatePackagePages(root, pages) };
}
export function planSelectedPackages(candidate: SelectedCandidate, resourceKeys: readonly string[]): readonly PackageRow[] {
  check(resourceKeys.length > 0 && new Set(resourceKeys).size === resourceKeys.length, 'explicit unique resource keys required');
  const keys = new Map(candidate.rows.map(row => [row.resourceKey, row]));
  const digests = new Map(candidate.rows.map(row => [row.packageSha256, row]));
  check(digests.size === candidate.rows.length, 'ambiguous package digest across directory');
  const visited = new Set<string>(), visiting = new Set<string>(), ordered: PackageRow[] = [];
  const visit = (row: PackageRow): void => {
    check(row.tier === candidate.root.tier && row.fullVersion === candidate.root.fullVersion, 'selected row identity mismatch');
    if (visited.has(row.packageSha256)) return;
    check(!visiting.has(row.packageSha256), 'cyclic package dependency'); visiting.add(row.packageSha256);
    for (const digest of row.dependencies) { const dependency = digests.get(digest); check(dependency, 'missing selected dependency'); visit(dependency); }
    visiting.delete(row.packageSha256); visited.add(row.packageSha256);
    ordered.push(JSON.parse(canonicalBytes(row).toString('utf8')) as PackageRow);
  };
  for (const key of resourceKeys) { const row = keys.get(key); check(row, `selected resource absent: ${key}`); visit(row); }
  return ordered;
}
function object(value: unknown): Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value), 'manifest object required'); return value as Record<string, unknown>; }
export function verifySelectedPackage(row: PackageRow, bytes: Uint8Array): Readonly<Record<string, Uint8Array>> {
  check(['svg', 'code', 'shared', 'metadata', 'bitmap'].includes(row.kind), 'unsupported selected package kind');
  verifyPackagePayload(row, bytes);
  const tar = gunzipSync(bytes, { maxOutputLength: row.expandedBytes + (row.fileCount * 4 + 4) * 512 + 10240 });
  const entries = readTarEntries(tar, { maxEntries: row.fileCount * 4 + 4, maxExpandedBytes: row.expandedBytes + 1024 * 1024 });
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>; const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'dir' && entry.path === '.') continue;
    const name = entry.path.startsWith('./') ? entry.path.slice(2) : entry.path;
    check(name.length <= 1024 && !/[\\:]/.test(name) && ![...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !name.startsWith('/') && name.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe package path');
    check(!paths.has(name), 'duplicate package path'); paths.add(name);
    check(entry.type === 'file' || entry.type === 'dir', 'links and special files forbidden');
    if (entry.type === 'file') { check(entry.data, 'file bytes missing'); files[name] = entry.data; }
  }
  check(Object.keys(files).length === row.fileCount && Object.values(files).reduce((sum, b) => sum + b.length, 0) === row.expandedBytes, 'package inventory differs from row');
  const bytesManifest = files['manifest.json']; check(bytesManifest && bytesManifest.length <= 8 * 1024 ** 2, 'bounded package manifest required');
  const manifest = object(JSON.parse(Buffer.from(bytesManifest).toString('utf8')));
  check(Buffer.from(bytesManifest).equals(canonicalBytes(manifest)) && manifest.schemaVersion === 1, 'canonical package manifest required');
  const scope = ['kind', 'tier', 'styleGroupId', 'target', 'variant'] as const;
  check(Object.keys(manifest).every(k => ['schemaVersion', 'files', ...scope].includes(k)), 'unexpected manifest fields');
  for (const key of scope) check(canonicalBytes({ value: manifest[key] }).equals(canonicalBytes({ value: row[key] })), 'package scope differs from row');
  check(Array.isArray(manifest.files) && manifest.files.length === row.fileCount - 1, 'manifest inventory mismatch');
  const seen = new Set(['manifest.json']);
  for (const raw of manifest.files as unknown[]) {
    const item = object(raw); check(Object.keys(item).sort().join(',') === 'byteSize,path,sha256' && typeof item.path === 'string' && !seen.has(item.path), 'invalid manifest file'); seen.add(item.path);
    const data = files[item.path]; check(data && data.length === item.byteSize && sha256(data) === item.sha256, 'manifest file SHA/size mismatch');
    if (row.kind === 'svg') check(/^[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/.test(item.path), 'SVG package contains another resource kind');
    if (row.kind === 'code' || row.kind === 'shared') check(/\.(js|cjs|mjs|ts|cts|mts|tsx|jsx|json|map|vue)$/.test(item.path), 'code package contains non-code payload');
    if (row.kind === 'metadata') check(['metadata/MANUAL.md', 'metadata/catalog.json', 'metadata/manifest.json'].includes(item.path), 'unexpected metadata payload');
    if (row.kind === 'bitmap') check(new RegExp(`^icons/[a-z0-9]+(?:-[a-z0-9]+)*\\.${row.variant?.format}$`).test(item.path), 'bitmap package crosses tuple scope');
  }
  return files;
}
export interface SelectedPackageIo {
  readCache(row: PackageRow): Promise<Uint8Array | undefined>;
  writeCache(row: PackageRow, bytes: Uint8Array): Promise<void>;
  download(row: PackageRow): Promise<Uint8Array>;
  consume(row: PackageRow, files: Readonly<Record<string, Uint8Array>>): Promise<void>;
  signal?: AbortSignal;
}
export async function consumeSelectedPackages(candidate: SelectedCandidate, resourceKeys: readonly string[], io: SelectedPackageIo): Promise<{ packageCount: number; networkBytes: number; cacheHits: number }> {
  const plan = planSelectedPackages(candidate, resourceKeys); let networkBytes = 0, cacheHits = 0;
  for (const row of plan) {
    io.signal?.throwIfAborted();
    let bytes = await io.readCache(row);
    const cached = bytes !== undefined;
    if (bytes !== undefined) cacheHits++; else { bytes = await io.download(row); networkBytes += bytes.length; }
    const files = verifySelectedPackage(row, bytes);
    // Cache only validated complete packages before consumption, so a later
    // target write failure can reuse this unit without another network fetch.
    if (!cached) await io.writeCache(row, bytes);
    await io.consume(row, files);
  }
  return { packageCount: plan.length, networkBytes, cacheHits };
}
