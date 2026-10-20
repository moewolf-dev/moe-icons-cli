'use strict';

// S01 contract: the root is a small reference snapshot; resource bytes live in
// independently addressed packages and are fetched only by selected consumers.
const crypto = require('node:crypto');

const MAX_ROOT_BYTES = 1 * 1024 ** 2;
const MAX_PAGE_BYTES = 8 * 1024 ** 2;
const MAX_PACKAGE_BYTES = 128 * 1024 ** 2;
const MAX_CODE_PACKAGE_BYTES = 32 * 1024 ** 2;
const MAX_PACKAGES = 20_000;
// Keep a tier candidate within the downstream website projection's existing
// selected-package byte ceiling. This is a protocol fail-closed bound, not an
// approved Hosted capacity budget.
const MAX_CANDIDATE_BYTES = 4 * 1024 ** 3;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(0|[1-9]\d*))?)?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TARGETS = new Set(['react', 'vue', 'vanilla']);
const KINDS = new Set(['bitmap', 'svg', 'code', 'shared', 'metadata', 'website']);

function fail(message) {
  throw new Error(`candidate-set: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}

function exactKeys(value, required, optional, field) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${field}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key} is not allowed`);
}

function positiveInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`${field} is outside its byte/count budget`);
  return value;
}

function validatePageRef(value, index, tier) {
  const field = `packagePages[${index}]`;
  record(value, field);
  exactKeys(value, ['filename', 'sha256', 'sizeBytes', 'packageCount'], [], field);
  const expectedName = `package-page-${tier}-${String(index + 1).padStart(4, '0')}.json`;
  if (value.filename !== expectedName) fail(`${field}.filename must be ${expectedName}`);
  if (!SHA256.test(value.sha256 || '')) fail(`${field}.sha256 must be lowercase SHA-256`);
  positiveInteger(value.sizeBytes, `${field}.sizeBytes`, MAX_PAGE_BYTES);
  positiveInteger(value.packageCount, `${field}.packageCount`, MAX_PACKAGES);
  return { filename: value.filename, sha256: value.sha256, sizeBytes: value.sizeBytes, packageCount: value.packageCount };
}

function parseCandidateSet(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_ROOT_BYTES) fail('root descriptor exceeds 1 MiB');
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { fail('root descriptor is not valid JSON'); }
  record(raw, 'root');
  if (!bytes.equals(canonicalBytes(raw))) fail('root descriptor is not canonical JSON');
  exactKeys(raw, ['schemaVersion', 'fullVersion', 'tier', 'sourceCommit', 'generatorCommit', 'packagePageCount', 'packagePages', 'packageSetSha256'], [], 'root');
  if (raw.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!VERSION.test(raw.fullVersion || '')) fail('fullVersion is invalid');
  if (raw.tier !== 'free' && raw.tier !== 'pro') fail('tier must be free or pro');
  if (!COMMIT.test(raw.sourceCommit || '') || !COMMIT.test(raw.generatorCommit || '')) fail('source/generator commit must be 40-char lowercase SHA-1');
  if (!Array.isArray(raw.packagePages) || raw.packagePages.length < 1 || raw.packagePages.length > 128) fail('packagePages count is outside 1..128');
  if (raw.packagePageCount !== raw.packagePages.length) fail('packagePageCount mismatch');
  const pages = raw.packagePages.map((page, index) => validatePageRef(page, index, raw.tier));
  if (!SHA256.test(raw.packageSetSha256 || '')) fail('packageSetSha256 must be lowercase SHA-256');
  const projection = {
    schemaVersion: 1,
    fullVersion: raw.fullVersion,
    tier: raw.tier,
    sourceCommit: raw.sourceCommit,
    generatorCommit: raw.generatorCommit,
    packagePageCount: pages.length,
    packagePages: pages,
  };
  if (sha256(canonicalBytes(projection)) !== raw.packageSetSha256) fail('packageSetSha256 mismatch');
  return { ...projection, packageSetSha256: raw.packageSetSha256 };
}

function createCandidateSet({ fullVersion, tier, sourceCommit, generatorCommit, packagePages }) {
  if (!Array.isArray(packagePages) || packagePages.length < 1 || packagePages.length > 128) fail('packagePages count is outside 1..128');
  if (tier !== 'free' && tier !== 'pro') fail('tier must be free or pro');
  const projection = {
    schemaVersion: 1,
    fullVersion,
    tier,
    sourceCommit,
    generatorCommit,
    packagePageCount: packagePages.length,
    packagePages,
  };
  const bytes = canonicalBytes(projection);
  if (bytes.length > MAX_ROOT_BYTES) fail('root descriptor exceeds 1 MiB');
  return canonicalBytes({ ...projection, packageSetSha256: sha256(bytes) });
}

function expectedResourceKey(item) {
  const { kind, tier, styleGroupId, target, variant } = item;
  if (kind === 'bitmap') return `bitmap/${tier}/${styleGroupId}/${variant.width}x${variant.height}/${variant.format}`;
  if (kind === 'svg') return `svg/${tier}/${styleGroupId}`;
  if (kind === 'code') return `code/${tier}/${target}/${styleGroupId}`;
  if (kind === 'shared') return `shared/${tier}/${target}`;
  if (kind === 'metadata') return `metadata/${tier}/${styleGroupId || 'common'}`;
  return `website/${tier}/${styleGroupId}`;
}

function validatePackage(item, index, fullVersion) {
  const field = `packages[${index}]`;
  record(item, field);
  exactKeys(item,
    ['packageSha256', 'filename', 'kind', 'tier', 'resourceKey', 'fullVersion', 'compressedBytes', 'expandedBytes', 'fileCount', 'dependencies'],
    ['styleGroupId', 'target', 'variant', 'inputSha256'], field);
  if (item.inputSha256 !== undefined && !SHA256.test(item.inputSha256)) fail(`${field}.inputSha256 must be lowercase SHA-256`);
  if (!KINDS.has(item.kind)) fail(`${field}.kind is not supported`);
  if (item.tier !== 'free' && item.tier !== 'pro') fail(`${field}.tier must be free or pro`);
  if (!SHA256.test(item.packageSha256 || '')) fail(`${field}.packageSha256 must be lowercase SHA-256`);
  if (item.filename !== `packages/${item.packageSha256}.tgz`) fail(`${field}.filename must be content-addressed`);
  positiveInteger(item.compressedBytes, `${field}.compressedBytes`, MAX_PACKAGE_BYTES);
  positiveInteger(item.expandedBytes, `${field}.expandedBytes`, MAX_PACKAGE_BYTES);
  if (!Number.isSafeInteger(item.fileCount) || item.fileCount < 1 || item.fileCount > 100_000) fail(`${field}.fileCount is invalid`);
  if (!Array.isArray(item.dependencies) || item.dependencies.some((sha) => !SHA256.test(sha)) || new Set(item.dependencies).size !== item.dependencies.length || item.dependencies.includes(item.packageSha256) || item.dependencies.some((sha, position) => position > 0 && item.dependencies[position - 1].localeCompare(sha, 'en') >= 0)) fail(`${field}.dependencies is invalid`);
  if (item.kind === 'bitmap') {
    if (!/^moe-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.styleGroupId || '')) fail(`${field}.styleGroupId is invalid`);
    record(item.variant, `${field}.variant`);
    exactKeys(item.variant, ['width', 'height', 'format'], [], `${field}.variant`);
    if (item.target !== undefined) fail(`${field}.target is not valid for bitmap`);
    if (!Number.isSafeInteger(item.variant.width) || item.variant.width < 1 || item.variant.width > 4096 || item.variant.height !== item.variant.width) fail(`${field}.variant must be a square bitmap size`);
    if (item.variant.format !== 'png' && item.variant.format !== 'webp') fail(`${field}.variant.format is unsupported`);
  } else if (item.kind === 'shared') {
    if (!TARGETS.has(item.target)) fail(`${field}.target is invalid`);
    if (item.styleGroupId !== undefined || item.variant !== undefined) fail(`${field} shared package cannot be group/variant scoped`);
  } else {
    if (!/^moe-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.styleGroupId || '')) fail(`${field}.styleGroupId is required`);
    if (item.kind === 'code' && !TARGETS.has(item.target)) fail(`${field}.target is invalid`);
    if (item.kind !== 'code' && item.target !== undefined) fail(`${field}.target is not valid for ${item.kind}`);
    if (item.variant !== undefined) fail(`${field}.variant is only valid for bitmap`);
  }
  const byteBudget = item.kind === 'metadata' ? MAX_PAGE_BYTES : ['svg', 'code', 'shared', 'website'].includes(item.kind) ? MAX_CODE_PACKAGE_BYTES : MAX_PACKAGE_BYTES;
  if (item.compressedBytes > byteBudget || item.expandedBytes > byteBudget) fail(`${field} exceeds the ${item.kind} package budget`);
  if (item.resourceKey !== expectedResourceKey(item)) fail(`${field}.resourceKey does not match its scope`);
  if (item.fullVersion !== fullVersion) fail(`${field}.fullVersion mismatch`);
  return item;
}

function parsePackagePage(input, expectedRef, expectedVersion, expectedTier) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_PAGE_BYTES) fail('package page exceeds 8 MiB');
  if (expectedRef) {
    if (bytes.length !== expectedRef.sizeBytes || sha256(bytes) !== expectedRef.sha256) fail('package page size/digest mismatch');
  }
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { fail('package page is not valid JSON'); }
  record(raw, 'page');
  if (!bytes.equals(canonicalBytes(raw))) fail('package page is not canonical JSON');
  exactKeys(raw, ['schemaVersion', 'fullVersion', 'tier', 'packages'], [], 'page');
  if (raw.schemaVersion !== 1 || raw.fullVersion !== expectedVersion || (raw.tier !== 'free' && raw.tier !== 'pro') || (expectedTier && raw.tier !== expectedTier) || !Array.isArray(raw.packages)) fail('package page identity/schema is invalid');
  if (raw.packages.length < 1 || raw.packages.length > MAX_PACKAGES) fail('package count is outside budget');
  const packages = raw.packages.map((item, index) => validatePackage(item, index, expectedVersion));
  if (packages.some((item) => item.tier !== raw.tier)) fail('package page contains a package from another tier');
  const keys = packages.map((item) => item.resourceKey);
  if (new Set(keys).size !== keys.length) fail('duplicate resourceKey in package page');
  if (new Set(packages.map((item) => item.packageSha256)).size !== packages.length) fail('duplicate package digest in package page');
  if (keys.some((key, index) => index > 0 && keys[index - 1].localeCompare(key, 'en') >= 0)) fail('packages must be sorted by unique resourceKey');
  if (expectedRef && expectedRef.packageCount !== packages.length) fail('packageCount mismatch');
  return { schemaVersion: 1, fullVersion: raw.fullVersion, tier: raw.tier, packages };
}

function verifyPackagePayload(row, input) {
  const bytes = Buffer.from(input);
  if (bytes.length !== row.compressedBytes) fail(`package ${row.resourceKey} byte count mismatch`);
  if (sha256(bytes) !== row.packageSha256) fail(`package ${row.resourceKey} SHA-256 mismatch`);
  return bytes;
}

function validatePackagePages(candidateSet, pageBytesByName) {
  const set = typeof candidateSet === 'object' && !Buffer.isBuffer(candidateSet)
    ? parseCandidateSet(canonicalBytes(candidateSet))
    : parseCandidateSet(candidateSet);
  const all = [];
  let compressedBytes = 0;
  let expandedBytes = 0;
  for (const ref of set.packagePages) {
    const bytes = pageBytesByName instanceof Map ? pageBytesByName.get(ref.filename) : pageBytesByName?.[ref.filename];
    if (!bytes) fail(`missing package page ${ref.filename}`);
    const page = parsePackagePage(bytes, ref, set.fullVersion, set.tier).packages;
    if (all.length + page.length > MAX_PACKAGES) fail(`candidate package count exceeds ${MAX_PACKAGES}`);
    for (const item of page) {
      compressedBytes += item.compressedBytes;
      expandedBytes += item.expandedBytes;
      if (compressedBytes > MAX_CANDIDATE_BYTES) fail(`candidate compressed package bytes exceed ${MAX_CANDIDATE_BYTES}`);
      if (expandedBytes > MAX_CANDIDATE_BYTES) fail(`candidate expanded package bytes exceed ${MAX_CANDIDATE_BYTES}`);
    }
    all.push(...page);
  }
  if (new Set(all.map((item) => item.packageSha256)).size !== all.length) {
    fail('duplicate package digest across candidate set');
  }
  const packageIds = new Set(all.map((item) => item.packageSha256));
  const keys = new Set();
  for (const item of all) {
    if (keys.has(item.resourceKey)) fail(`duplicate resourceKey across pages: ${item.resourceKey}`);
    keys.add(item.resourceKey);
    for (const dependency of item.dependencies) if (!packageIds.has(dependency)) fail(`missing dependency package ${dependency}`);
  }
  return all;
}

function buildCandidateSet({ fullVersion, tier, sourceCommit, generatorCommit, packages }) {
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > MAX_PACKAGES) fail(`package count is outside 1..${MAX_PACKAGES}`);
  if (tier !== 'free' && tier !== 'pro') fail('tier must be free or pro');
  if (packages.some((item) => item.tier !== tier)) fail('candidate-set packages must belong to exactly one tier');
  const sorted = packages.map((item, index) => validatePackage(item, index, fullVersion))
    .sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, 'en'));
  let compressedBytes = 0;
  let expandedBytes = 0;
  for (const item of sorted) {
    compressedBytes += item.compressedBytes;
    expandedBytes += item.expandedBytes;
    if (compressedBytes > MAX_CANDIDATE_BYTES) fail(`candidate compressed package bytes exceed ${MAX_CANDIDATE_BYTES}`);
    if (expandedBytes > MAX_CANDIDATE_BYTES) fail(`candidate expanded package bytes exceed ${MAX_CANDIDATE_BYTES}`);
  }
  const keys = sorted.map((item) => item.resourceKey);
  if (new Set(keys).size !== keys.length) fail('duplicate resourceKey across candidate set');
  const pageBytesByName = new Map();
  const refs = [];
  let page = [];
  function flush() {
    if (!page.length) return;
    const index = refs.length + 1;
    const filename = `package-page-${tier}-${String(index).padStart(4, '0')}.json`;
    const bytes = canonicalBytes({ schemaVersion: 1, fullVersion, tier, packages: page });
    if (bytes.length > MAX_PAGE_BYTES) fail(`package page ${index} exceeds 8 MiB`);
    refs.push({ filename, sha256: sha256(bytes), sizeBytes: bytes.length, packageCount: page.length });
    pageBytesByName.set(filename, bytes);
    page = [];
  }
  for (const item of sorted) {
    const tentative = canonicalBytes({ schemaVersion: 1, fullVersion, tier, packages: [...page, item] });
    if (tentative.length > MAX_PAGE_BYTES && page.length) flush();
    page.push(item);
    if (canonicalBytes({ schemaVersion: 1, fullVersion, tier, packages: page }).length > MAX_PAGE_BYTES) fail(`package ${item.resourceKey} cannot fit within one metadata page`);
  }
  flush();
  if (refs.length > 128) fail('package page count exceeds 128');
  const rootBytes = createCandidateSet({ fullVersion, tier, sourceCommit, generatorCommit, packagePages: refs });
  const candidateSet = parseCandidateSet(rootBytes);
  validatePackagePages(candidateSet, pageBytesByName);
  return { candidateSet, rootBytes, pageBytesByName };
}

module.exports = {
  MAX_ROOT_BYTES,
  MAX_PAGE_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_CODE_PACKAGE_BYTES,
  MAX_PACKAGES,
  MAX_CANDIDATE_BYTES,
  canonicalBytes,
  sha256,
  parseCandidateSet,
  parsePackagePage,
  verifyPackagePayload,
  validatePackagePages,
  createCandidateSet,
  buildCandidateSet,
  expectedResourceKey,
};
