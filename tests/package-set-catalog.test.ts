import { it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const candidateTools = require("../src/core/small-pack/candidate-set.cjs");
const metadataModule = import("../scripts/package-set-catalog.mjs") as Promise<{
  fetchPackageSetCatalog(input: { bindings: Record<string, unknown>; proToken?: string; fetcher?: typeof fetch }): Promise<Record<string, any>>;
}>;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const version = "1.2.3";
const sourceCommit = "a".repeat(40);
const generatorCommit = "b".repeat(40);
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function tarEntry(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - body.byteLength % 512) % 512)]);
}

function metadataPackage(tier: "free" | "pro", groupId: string, icons: string[]) {
  const catalog = {
    schemaVersion: 1,
    styleGroups: [{ id: groupId, type: "outline", tiers: ["free", "pro"], formats: ["svg"], imageSizes: [] }],
    icons: icons.map(id => ({ id, name: id, prefix: id.split("-")[0], label: id, aliases: [], keywords: [], categories: [], targets: ["react", "vue", "vanilla", "assets"], variants: [groupId], availableIn: [groupId] })),
  };
  const manual = Buffer.from(`# ${tier} ${groupId}\n`);
  const catalogBytes = json(catalog);
  const innerManifest = json({
    schemaVersion: 1,
    tier,
    styleGroupId: groupId,
    targets: ["react", "vue", "vanilla", "assets"],
    dependencies: { react: { react: ">=17.0.0", "react-dom": ">=17.0.0" }, vue: { vue: ">=3.2.0" }, vanilla: {}, assets: {} },
    files: {
      "MANUAL.md": { size: manual.byteLength, sha256: hash(manual) },
      "catalog.json": { size: catalogBytes.byteLength, sha256: hash(catalogBytes) },
    },
  });
  const payload = [
    ["metadata/MANUAL.md", manual],
    ["metadata/catalog.json", catalogBytes],
    ["metadata/manifest.json", innerManifest],
  ] as const;
  const manifestBytes = candidateTools.canonicalBytes({
    schemaVersion: 1,
    kind: "metadata",
    tier,
    styleGroupId: groupId,
    files: payload.map(([path, bytes]) => ({ path, byteSize: bytes.byteLength, sha256: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path, "en")),
  });
  const files = [["manifest.json", manifestBytes] as const, ...payload];
  const expandedBytes = files.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
  const members = Buffer.concat([...files.map(([path, bytes]) => tarEntry(path, bytes)), Buffer.alloc(1024)]);
  const tarRecordBytes = 10 * 1024;
  const tar = Buffer.concat([members, Buffer.alloc(Math.ceil(members.byteLength / tarRecordBytes) * tarRecordBytes - members.byteLength)]);
  assert.equal(tar.byteLength % tarRecordBytes, 0, "fixture must match GNU-format tar record padding");
  assert.ok(expandedBytes + files.length * 1024 + 1024 < tar.byteLength,
    "small metadata fixture must exceed the former gzip expansion cap");
  const archive = gzipSync(tar);
  const digest = hash(archive);
  return {
    archive,
    row: {
      packageSha256: digest,
      filename: `packages/${digest}.tgz`,
      kind: "metadata",
      tier,
      resourceKey: `metadata/${tier}/${groupId}`,
      styleGroupId: groupId,
      fullVersion: version,
      compressedBytes: archive.byteLength,
      expandedBytes,
      fileCount: files.length,
      dependencies: [],
    },
  };
}

function fixture(freeGroup = "moe-outline") {
  const archives = new Map<string, Buffer>();
  const sets: Record<string, any> = {};
  for (const tier of ["free", "pro"] as const) {
    const groups = tier === "free" ? [[freeGroup, ["archive-box"]]] : [["moe-outline", ["archive-box"]], ["moe-game-blue", ["pixel-sword"]]];
    const rows = groups.map(([group, ids]) => {
      const item = metadataPackage(tier, group as string, ids as string[]);
      archives.set(item.row.packageSha256, item.archive);
      return item.row;
    });
    // A non-metadata object proves the plugin inventory reader never downloads it.
    const dummy = Buffer.from(`${tier} svg bytes`);
    const dummyDigest = hash(dummy);
    rows.push({ packageSha256: dummyDigest, filename: `packages/${dummyDigest}.tgz`, kind: "svg", tier, resourceKey: `svg/${tier}/moe-outline`, styleGroupId: "moe-outline", fullVersion: version, compressedBytes: dummy.byteLength, expandedBytes: dummy.byteLength, fileCount: 1, dependencies: [] });
    const built = candidateTools.buildCandidateSet({ fullVersion: version, tier, sourceCommit, generatorCommit, packages: rows });
    const root = candidateTools.parseCandidateSet(built.rootBytes);
    const binding = { packageSetSha256: root.packageSetSha256, candidateRootSha256: hash(built.rootBytes), candidateRootBytes: built.rootBytes.byteLength };
    sets[tier] = { built, root, binding };
  }
  const bindings = { schemaVersion: 1, resourceVersion: version, sourceCommit, generatorCommit, free: sets.free.binding, pro: sets.pro.binding };
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    calls.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const tier = url.pathname.includes("/pro/") ? "pro" : "free";
    if (tier === "pro") assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + "t".repeat(40));
    else assert.equal(new Headers(init?.headers).get("authorization"), null);
    const set = sets[tier];
    const identity = { schemaVersion: 1, tier, fullVersion: version, sourceCommit, generatorCommit, packageSetSha256: set.binding.packageSetSha256, candidateRootSha256: set.binding.candidateRootSha256, candidateRootBytes: set.binding.candidateRootBytes, updatedAt: "2026-10-17T00:00:00.000Z" };
    if (url.pathname === `/v1/icon-library/${tier}/package-set`) return Response.json(identity);
    if (url.pathname.endsWith("/root")) return new Response(set.built.rootBytes);
    const pageMatch = /\/pages\/(\d+)$/.exec(url.pathname);
    if (pageMatch) return new Response(set.built.pageBytesByName.get(`package-page-${tier}-${Number(pageMatch[1]).toString().padStart(4, "0")}.json`));
    const packageMatch = /\/packages\/([a-f0-9]{64})\.tgz$/.exec(url.pathname);
    if (packageMatch) {
      const archive = archives.get(packageMatch[1]!);
      return archive ? new Response(archive) : new Response("not found", { status: 404 });
    }
    return new Response("unexpected request", { status: 404 });
  };
  return { bindings, calls, fetcher, archives };
}

it("fetches exact Free/Pro candidate sets and merges verified scoped metadata into a catalog", async () => {
  const { fetchPackageSetCatalog } = await metadataModule;
  const f = fixture();
  const catalog = await fetchPackageSetCatalog({ bindings: f.bindings, proToken: "t".repeat(40), fetcher: f.fetcher });
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.manifestSchemaVersion, 2);
  assert.deepEqual(catalog.styleGroups.map((group: any) => group.id), ["moe-game-blue", "moe-outline"]);
  assert.deepEqual(catalog.icons.map((icon: any) => icon.id), ["archive-box", "pixel-sword"]);
  assert.equal(catalog.icons.find((icon: any) => icon.id === "pixel-sword").availableIn[0], "moe-game-blue");
  const downloaded = f.calls.map(url => /\/packages\/([a-f0-9]{64})\.tgz$/.exec(url.pathname)?.[1]).filter(Boolean);
  assert.equal(downloaded.length, 3);
  assert.ok(downloaded.every(digest => f.archives.has(digest!)));
  assert.ok(f.calls.every(url => url.searchParams.get("version") === version));
  assert.ok(f.calls.every(url => url.searchParams.get("packageSetSha256") === f.bindings[url.pathname.includes("/pro/") ? "pro" : "free"].packageSetSha256));
});

it("rejects Pro-set reads without the workflow credential before issuing requests", async () => {
  const { fetchPackageSetCatalog } = await metadataModule;
  const f = fixture();
  await assert.rejects(fetchPackageSetCatalog({ bindings: f.bindings, fetcher: f.fetcher }), /Pro package-set workflow credential is required/);
  assert.equal(f.calls.length, 0);
});

it("rejects package digest tampering and preserves strict metadata scope", async () => {
  const { fetchPackageSetCatalog } = await metadataModule;
  const f = fixture();
  const original = f.fetcher;
  const corruptFetcher: typeof fetch = async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    if (url.pathname.includes("/packages/")) return new Response("changed bytes");
    return original(request, init);
  };
  await assert.rejects(fetchPackageSetCatalog({ bindings: f.bindings, proToken: "t".repeat(40), fetcher: corruptFetcher }), /metadata\/free\/moe-outline byte count differs from its binding/);
});

it("rejects a Pro-only group mislabeled into the Free candidate before reading its package", async () => {
  const { fetchPackageSetCatalog } = await metadataModule;
  const f = fixture("moe-game-blue");
  await assert.rejects(fetchPackageSetCatalog({ bindings: f.bindings, proToken: "t".repeat(40), fetcher: f.fetcher }), /outside the pinned allowlist/);
  assert.equal(f.calls.some(url => url.pathname.includes('/free/package-set/packages/')), false);
});
