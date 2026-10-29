import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const candidateTools = require("../src/core/small-pack/candidate-set.cjs");
const tarTools = require("../src/core/small-pack/tar-read.cjs");
const freePolicy = require("../vendor/moe-icons-release-policy/free-style-groups.v1.json");

const MAX_ROOT_BYTES = 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_PACKAGES = 512;
const HEX = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(0|[1-9]\d*))?)?$/;
const GROUP = /^moe-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TARGETS = new Set(["react", "vue", "vanilla", "assets"]);

function assert(condition, message) {
  if (!condition) throw new Error(`package-set metadata: ${message}`);
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} has unexpected or missing fields`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateBindings(value) {
  exactKeys(value, ["schemaVersion", "resourceVersion", "sourceCommit", "generatorCommit", "free", "pro"], "producer binding");
  assert(value.schemaVersion === 1 && VERSION.test(value.resourceVersion || "")
    && COMMIT.test(value.sourceCommit || "") && COMMIT.test(value.generatorCommit || ""), "producer identity is invalid");
  for (const tier of ["free", "pro"]) {
    const row = value[tier];
    exactKeys(row, ["packageSetSha256", "candidateRootSha256", "candidateRootBytes"], `${tier} binding`);
    assert(HEX.test(row.packageSetSha256 || "") && HEX.test(row.candidateRootSha256 || "")
      && Number.isSafeInteger(row.candidateRootBytes) && row.candidateRootBytes > 0 && row.candidateRootBytes <= MAX_ROOT_BYTES,
    `${tier} candidate binding is invalid`);
  }
  assert(value.free.packageSetSha256 !== value.pro.packageSetSha256, "Free and Pro sets must be distinct");
  return value;
}

async function readBoundedBody(response, maximumBytes, expectedBytes, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    assert(/^\d+$/.test(declared), `${label} Content-Length is invalid`);
    const size = Number(declared);
    assert(Number.isSafeInteger(size) && size <= maximumBytes, `${label} exceeds its byte budget`);
    if (expectedBytes !== undefined) assert(size === expectedBytes, `${label} Content-Length differs from its binding`);
  }
  assert(response.body, `${label} body is missing`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      assert(total <= maximumBytes && (expectedBytes === undefined || total <= expectedBytes), `${label} exceeds its byte budget`);
      chunks.push(part.value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* preserve the original failure */ }
    throw error;
  }
  if (expectedBytes !== undefined) assert(total === expectedBytes, `${label} byte count differs from its binding`);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function endpointUrl(baseUrl, path, binding) {
  const base = new URL(baseUrl);
  assert(base.protocol === "https:" && !base.username && !base.password, "API base URL must be HTTPS without embedded credentials");
  const url = new URL(path, base.origin);
  url.searchParams.set("version", binding.resourceVersion);
  url.searchParams.set("packageSetSha256", binding.packageSetSha256);
  return url;
}

async function getBytes({ fetcher, url, maximumBytes, expectedBytes, token, label }) {
  const headers = new Headers({ Accept: "application/json, application/gzip" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetcher(url, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(30000) });
  assert(response.status === 200, `${label} API returned HTTP ${response.status}`);
  return readBoundedBody(response, maximumBytes, expectedBytes, label);
}

function parseIdentity(bytes, tier) {
  let raw;
  try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("package-set metadata: candidate identity is not JSON"); }
  exactKeys(raw, ["schemaVersion", "tier", "fullVersion", "sourceCommit", "generatorCommit", "packageSetSha256", "candidateRootSha256", "candidateRootBytes", "updatedAt"], "candidate identity");
  assert(raw.schemaVersion === 1 && raw.tier === tier && VERSION.test(raw.fullVersion || "")
    && COMMIT.test(raw.sourceCommit || "") && COMMIT.test(raw.generatorCommit || "")
    && HEX.test(raw.packageSetSha256 || "") && HEX.test(raw.candidateRootSha256 || "")
    && Number.isSafeInteger(raw.candidateRootBytes) && raw.candidateRootBytes > 0 && raw.candidateRootBytes <= MAX_ROOT_BYTES
    && typeof raw.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw.updatedAt)
    && !Number.isNaN(Date.parse(raw.updatedAt)), "candidate identity fields are invalid");
  return raw;
}

function verifyArchive(row, compressed) {
  candidateTools.verifyPackagePayload(row, compressed);
  let tarBytes;
  try {
    // GNU-format tar rounds the stream to a 10 KiB record. Reserve per-file
    // headers/data padding and bounded GNU/PAX metadata before gunzip; the
    // strict tar reader and embedded manifest enforce the exact inventory.
    const maximum = Math.min(16 * 1024 * 1024, row.expandedBytes + (row.fileCount + 8) * 1024 + 16 * 1024);
    tarBytes = gunzipSync(compressed, { maxOutputLength: maximum });
  } catch (error) {
    throw new Error(`package-set metadata: gzip failed for ${row.resourceKey}: ${String(error)}`);
  }
  const archive = tarTools.readTarEntries(tarBytes, { maxEntries: Math.min(64, row.fileCount + 8), maxExpandedBytes: row.expandedBytes });
  assert(archive.length === row.fileCount && archive.every(item => item.type === "file" && item.data), `${row.resourceKey} has an invalid tar inventory`);
  let expandedBytes = 0;
  const files = new Map();
  for (const item of archive) {
    const name = item.path;
    assert(typeof name === "string" && name.length > 0 && name === name.normalize("NFC")
      && !name.startsWith("/") && !name.includes("\\") && name.split("/").every(part => part && part !== "." && part !== ".."),
    `${row.resourceKey} has an unsafe tar path`);
    assert(!files.has(name), `${row.resourceKey} has a duplicate tar path`);
    files.set(name, item.data);
    expandedBytes += item.size;
  }
  assert(expandedBytes === row.expandedBytes, `${row.resourceKey} expanded byte count mismatch`);

  const manifestBytes = files.get("manifest.json");
  assert(manifestBytes, `${row.resourceKey} package manifest is missing`);
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { throw new Error(`package-set metadata: ${row.resourceKey} manifest is not JSON`); }
  const scope = { schemaVersion: 1, kind: row.kind, tier: row.tier, styleGroupId: row.styleGroupId };
  const payloadFiles = [...files.entries()].filter(([name]) => name !== "manifest.json")
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([name, bytes]) => ({ path: name, byteSize: bytes.byteLength, sha256: candidateTools.sha256(bytes) }));
  assert(Buffer.from(manifestBytes).equals(candidateTools.canonicalBytes({ ...scope, files: payloadFiles })), `${row.resourceKey} package manifest scope or file hashes mismatch`);
  files.delete("manifest.json");

  const innerBytes = files.get("metadata/manifest.json");
  const catalogBytes = files.get("metadata/catalog.json");
  const manualBytes = files.get("metadata/MANUAL.md");
  assert(innerBytes && catalogBytes && manualBytes && files.size === 3, `${row.resourceKey} does not contain exactly the scoped metadata files`);
  let inner;
  try { inner = JSON.parse(new TextDecoder().decode(innerBytes)); } catch { throw new Error(`package-set metadata: ${row.resourceKey} inner manifest is not JSON`); }
  exactKeys(inner, ["schemaVersion", "tier", "styleGroupId", "targets", "dependencies", "files"], `${row.resourceKey} inner manifest`);
  assert(inner.schemaVersion === 1 && inner.tier === row.tier && inner.styleGroupId === row.styleGroupId
    && Array.isArray(inner.targets) && inner.targets.length === 4 && new Set(inner.targets).size === 4 && inner.targets.every(target => TARGETS.has(target))
    && inner.dependencies && typeof inner.dependencies === "object" && !Array.isArray(inner.dependencies), `${row.resourceKey} inner manifest scope is invalid`);
  exactKeys(inner.files, ["MANUAL.md", "catalog.json"], `${row.resourceKey} inner file inventory`);
  for (const [name, bytes] of [["MANUAL.md", manualBytes], ["catalog.json", catalogBytes]]) {
    exactKeys(inner.files[name], ["size", "sha256"], `${row.resourceKey} inner ${name} digest`);
    assert(inner.files[name].size === bytes.byteLength && inner.files[name].sha256 === sha256(bytes), `${row.resourceKey} inner ${name} digest mismatch`);
  }
  return JSON.parse(new TextDecoder().decode(catalogBytes));
}

function validateCatalog(catalog, row, tier) {
  assert(catalog && typeof catalog === "object" && catalog.schemaVersion === 1
    && Array.isArray(catalog.styleGroups) && catalog.styleGroups.length === 1
    && Array.isArray(catalog.icons) && catalog.icons.length > 0, `${row.resourceKey} catalog schema is invalid`);
  const group = catalog.styleGroups[0];
  assert(group && group.id === row.styleGroupId && GROUP.test(group.id)
    && Array.isArray(group.tiers) && group.tiers.includes(tier)
    && Array.isArray(group.formats) && group.formats.length > 0 && group.formats.every(format => ["svg", "png", "webp", "jpeg", "jpg"].includes(format)),
  `${row.resourceKey} catalog group scope is invalid`);
  const seen = new Set();
  for (const icon of catalog.icons) {
    assert(icon && typeof icon === "object" && ICON.test(icon.id || "") && Array.isArray(icon.availableIn)
      && icon.availableIn.length === 1 && icon.availableIn[0] === row.styleGroupId
      && Array.isArray(icon.variants) && icon.variants.length === 1 && icon.variants[0] === row.styleGroupId
      && Array.isArray(icon.targets) && icon.targets.length > 0 && icon.targets.every(target => TARGETS.has(target)),
    `${row.resourceKey} contains an invalid or out-of-scope icon`);
    assert(!seen.has(icon.id), `${row.resourceKey} contains a duplicate icon id`);
    seen.add(icon.id);
  }
  return catalog;
}

async function fetchTier({ tier, binding, baseUrl, token, fetcher }) {
  if (tier === "pro") assert(typeof token === "string" && token.length >= 32 && token.length <= 256 && !/[\r\n]/.test(token), "Pro package-set workflow credential is required");
  const route = `/v1/icon-library/${tier}/package-set`;
  const identityBytes = await getBytes({ fetcher, url: endpointUrl(baseUrl, route, { ...binding, ...binding[tier] }), maximumBytes: 16 * 1024, token, label: `${tier} identity` });
  const identity = parseIdentity(identityBytes, tier);
  assert(identity.fullVersion === binding.resourceVersion && identity.sourceCommit === binding.sourceCommit
    && identity.generatorCommit === binding.generatorCommit && identity.packageSetSha256 === binding[tier].packageSetSha256
    && identity.candidateRootSha256 === binding[tier].candidateRootSha256 && identity.candidateRootBytes === binding[tier].candidateRootBytes,
  `${tier} API identity differs from the exact producer binding`);

  const rootBytes = await getBytes({ fetcher, url: endpointUrl(baseUrl, `${route}/root`, { ...binding, ...binding[tier] }), maximumBytes: MAX_ROOT_BYTES, expectedBytes: binding[tier].candidateRootBytes, token, label: `${tier} root` });
  assert(sha256(rootBytes) === binding[tier].candidateRootSha256, `${tier} root digest mismatch`);
  const root = candidateTools.parseCandidateSet(rootBytes);
  assert(root.tier === tier && root.fullVersion === binding.resourceVersion && root.sourceCommit === binding.sourceCommit
    && root.generatorCommit === binding.generatorCommit && root.packageSetSha256 === binding[tier].packageSetSha256,
  `${tier} root differs from the producer binding`);
  const pageBytesByName = new Map();
  let totalPageBytes = 0;
  for (let index = 0; index < root.packagePages.length; index += 1) {
    const page = root.packagePages[index];
    totalPageBytes += page.sizeBytes;
    assert(page.sizeBytes <= MAX_PAGE_BYTES && totalPageBytes <= MAX_TOTAL_PAGE_BYTES, `${tier} package pages exceed the inventory budget`);
    const bytes = await getBytes({ fetcher, url: endpointUrl(baseUrl, `${route}/pages/${index + 1}`, { ...binding, ...binding[tier] }), maximumBytes: MAX_PAGE_BYTES, expectedBytes: page.sizeBytes, token, label: `${tier} page ${index + 1}` });
    assert(sha256(bytes) === page.sha256, `${tier} page digest mismatch`);
    pageBytesByName.set(page.filename, bytes);
  }
  const rows = candidateTools.validatePackagePages(root, pageBytesByName);
  if (tier === "free") assert(rows.every(row => !row.styleGroupId || freePolicy.freeStyleGroups.includes(row.styleGroupId)),
    "Free candidate contains a group outside the pinned allowlist");
  const metadataRows = rows.filter(row => row.kind === "metadata");
  assert(metadataRows.length > 0 && metadataRows.length <= MAX_METADATA_PACKAGES
    && metadataRows.every(row => row.tier === tier && GROUP.test(row.styleGroupId || "")), `${tier} metadata package inventory is invalid`);
  assert(new Set(metadataRows.map(row => row.styleGroupId)).size === metadataRows.length, `${tier} has duplicate metadata groups`);
  const totalMetadataBytes = metadataRows.reduce((sum, row) => sum + row.compressedBytes, 0);
  assert(totalMetadataBytes <= 64 * 1024 * 1024, `${tier} metadata packages exceed the aggregate byte budget`);

  const groups = [];
  for (const row of metadataRows) {
    assert(row.compressedBytes <= MAX_PACKAGE_BYTES && row.expandedBytes <= MAX_PACKAGE_BYTES && row.fileCount === 4,
      `${row.resourceKey} exceeds the metadata package contract`);
    const bytes = await getBytes({ fetcher, url: endpointUrl(baseUrl, `${route}/packages/${row.packageSha256}.tgz`, { ...binding, ...binding[tier] }), maximumBytes: MAX_PACKAGE_BYTES, expectedBytes: row.compressedBytes, token, label: row.resourceKey });
    groups.push(validateCatalog(verifyArchive(row, bytes), row, tier));
  }
  return { tier, identity, groups };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }

function stripScopedIcon(icon) {
  const { variants, availableIn, ...rest } = icon;
  return rest;
}

function mergeCatalogs(binding, freeGroups, proGroups) {
  const freeById = new Map(freeGroups.map(catalog => [catalog.styleGroups[0].id, catalog]));
  const proById = new Map(proGroups.map(catalog => [catalog.styleGroups[0].id, catalog]));
  assert(freeById.size === freeGroups.length && proById.size === proGroups.length, "duplicate metadata group identity");
  assert(freeById.size > 0 && proById.size > 0, "candidate metadata contains no style groups");

  for (const [groupId, freeCatalog] of freeById) {
    const proCatalog = proById.get(groupId);
    assert(proCatalog, `Pro candidate omits Free group ${groupId}`);
    assert(canonicalJson(freeCatalog.styleGroups[0]) === canonicalJson(proCatalog.styleGroups[0]), `Free and Pro style-group metadata differs for ${groupId}`);
    const proIcons = new Map(proCatalog.icons.map(icon => [icon.id, icon]));
    for (const freeIcon of freeCatalog.icons) {
      const proIcon = proIcons.get(freeIcon.id);
      assert(proIcon && canonicalJson(stripScopedIcon(freeIcon)) === canonicalJson(stripScopedIcon(proIcon)), `Free and Pro icon metadata differs for ${groupId}/${freeIcon.id}`);
    }
  }

  const iconsById = new Map();
  for (const [groupId, groupCatalog] of proById) {
    for (const icon of groupCatalog.icons) {
      const prior = iconsById.get(icon.id);
      if (prior) {
        assert(canonicalJson(stripScopedIcon(prior)) === canonicalJson(stripScopedIcon(icon)), `inconsistent metadata for repeated icon ${icon.id}`);
        prior.availableIn.push(groupId);
        prior.variants.push(groupId);
      } else iconsById.set(icon.id, { ...icon, availableIn: [groupId], variants: [groupId] });
    }
  }
  assert(iconsById.size > 0, "verified metadata contains no icon entries");
  const catalog = {
    schemaVersion: 1,
    catalogVersion: binding.resourceVersion,
    sourceVersion: binding.resourceVersion,
    sourceCommit: binding.sourceCommit,
    generatorCommit: binding.generatorCommit,
    manifestSchemaVersion: 2,
    styleGroups: [...proById.values()].map(value => value.styleGroups[0]).sort((a, b) => a.id.localeCompare(b.id, "en")),
    icons: [...iconsById.values()].map(icon => ({
      ...icon,
      availableIn: [...new Set(icon.availableIn)].sort((a, b) => a.localeCompare(b, "en")),
      variants: [...new Set(icon.variants)].sort((a, b) => a.localeCompare(b, "en")),
    })).sort((a, b) => a.id.localeCompare(b.id, "en")),
  };
  validateMergedCatalog(catalog, freeById, proById);
  return catalog;
}

function validateMergedCatalog(catalog, freeById, proById) {
  const groups = catalog.styleGroups;
  const groupIds = groups.map(group => group.id);
  assert(groupIds.length === proById.size && new Set(groupIds).size === groupIds.length
    && groupIds.every(id => proById.has(id)) && [...freeById.keys()].every(id => proById.has(id)), "merged catalog groups differ from candidate metadata inventory");
  assert(catalog.icons.length > 0 && new Set(catalog.icons.map(icon => icon.id)).size === catalog.icons.length, "merged catalog has no icons or duplicate IDs");
  const allowed = new Set(groupIds);
  for (const group of groups) {
    assert(GROUP.test(group.id || "") && Array.isArray(group.tiers) && group.tiers.includes("pro")
      && Array.isArray(group.formats) && group.formats.length > 0 && Array.isArray(group.imageSizes), `merged catalog group ${group.id} is invalid`);
  }
  for (const icon of catalog.icons) {
    assert(ICON.test(icon.id || "") && typeof icon.prefix === "string" && typeof icon.label === "string"
      && Array.isArray(icon.aliases) && Array.isArray(icon.availableIn) && icon.availableIn.length > 0
      && new Set(icon.availableIn).size === icon.availableIn.length && icon.availableIn.every(id => allowed.has(id))
      && Array.isArray(icon.variants) && icon.variants.length === icon.availableIn.length
      && icon.variants.every(id => icon.availableIn.includes(id)), `merged catalog icon ${icon.id} is invalid`);
  }
}

/** Download and verify the Free/Pro metadata packages from the exact candidate sets. */
export async function fetchPackageSetCatalog({ bindings, apiBaseUrl = "https://api.moeicons.com", proToken, fetcher = fetch }) {
  const binding = validateBindings(bindings);
  assert(typeof proToken === "string" && proToken.length >= 32 && proToken.length <= 256 && !/[\r\n]/.test(proToken), "Pro package-set workflow credential is required");
  const [free, pro] = await Promise.all([
    fetchTier({ tier: "free", binding, baseUrl: apiBaseUrl, fetcher }),
    fetchTier({ tier: "pro", binding, baseUrl: apiBaseUrl, token: proToken, fetcher }),
  ]);
  return mergeCatalogs(binding, free.groups, pro.groups);
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  assert(inputPath && outputPath, "usage: node scripts/package-set-catalog.mjs <verified-binding.json> <output.json>");
  const fs = await import("node:fs/promises");
  const stat = await fs.lstat(inputPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024, "package-set binding file is outside its size/type budget");
  const inputBytes = await fs.readFile(inputPath);
  assert(inputBytes.byteLength === stat.size, "package-set binding file changed while being read");
  let bindings;
  try { bindings = JSON.parse(inputBytes.toString("utf8")); } catch { throw new Error("package-set catalog: binding file is not JSON"); }
  const { ACTIONS_OIDC_MARKER, createActionsOidcFetch } = require("./actions-oidc-fetch.cjs");
  const apiBaseUrl = process.env.MOEICONS_API_BASE_URL || "https://api.moeicons.com";
  const token = process.env.PRO_PACKAGE_SET_WORKFLOW_TOKEN;
  const catalog = await fetchPackageSetCatalog({
    bindings, apiBaseUrl, proToken: token || ACTIONS_OIDC_MARKER,
    ...(token ? {} : { fetcher: createActionsOidcFetch({ apiBaseUrl }) }),
  });
  const output = `${JSON.stringify(catalog, null, 2)}\n`;
  assert(Buffer.byteLength(output) <= 32 * 1024 * 1024, "generated catalog exceeds 32 MiB");
  await fs.writeFile(outputPath, output, { flag: "wx", mode: 0o600 });
  process.stdout.write(`wrote ${catalog.icons.length} icons across ${catalog.styleGroups.length} groups for ${catalog.catalogVersion}\n`);
}

if (process.argv[1]?.endsWith("package-set-catalog.mjs")) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
