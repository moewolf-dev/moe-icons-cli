import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadFreeRelease, downloadMetadataArchive } from "../src/core/free-download.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";
import { parseReleaseDescriptor } from "../src/core/release-descriptor.js";
import { createTarGz } from "../src/project/tar-gz.js";
import { extractAndVerifyMetadataArchive } from "../src/metadata/archive.js";

describe("metadata archive download hardening (MC.3)", () => {
  let fixture: string;
  let cache: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "meta-dl-"));
    cache = mkdtempSync(join(tmpdir(), "meta-dl-cache-"));
  });
  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function io(overrides: { fixtureDir?: string } = {}) {
    return {
      fetchFn: globalThis.fetch.bind(globalThis),
      readFileSync: (p: string) => new Uint8Array(readFileSync(p)),
      writeFileSync: (p: string, d: Uint8Array) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, d); },
      mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
      existsSync: (p: string) => existsSync(p),
      renameSync,
      rmSync,
      fixtureDir: overrides.fixtureDir ?? fixture,
      cacheDir: cache,
      cliVersion: "0.1.0",
      signal: new AbortController().signal,
    };
  }

  it("fails when the metadata archive is corrupt (checksum mismatch) and caches nothing", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    writeFileSync(join(fixture, meta.metadataName), Buffer.from("not-a-metadata-tgz"));
    const result = await downloadFreeRelease(io(), meta.version);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("checksum-mismatch");
  });

  it("fails when the descriptor omits the metadata archive", async () => {
    const meta = writeFreeReleaseFixture(fixture, { omitMetadata: true });
    const result = await downloadFreeRelease(io(), meta.version);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("validation");
  });

  it("rejects a metadata archive whose manifest tier does not match the code tier", async () => {
    const meta = writeFreeReleaseFixture(fixture, { tier: "pro" });
    const result = await downloadFreeRelease(io(), meta.version);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("validation");
      expect(result.message).toContain("tier");
    }
  });

  it("downloadMetadataArchive verifies the catalog digest inside the archive", async () => {
    const meta = writeFreeReleaseFixture(fixture);
    const descriptor = parseReleaseDescriptor(new Uint8Array(readFileSync(join(fixture, "release-descriptor.json"))));
    const result = await downloadMetadataArchive(
      io(),
      descriptor.free.metadata!,
      "f".repeat(64),
      "free",
      meta.version,
      `v${meta.version}`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("checksum-mismatch");
  });
});

describe("metadata archive strict whitelist (R6)", () => {
  let cache: string;

  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "meta-whitelist-cache-"));
  });
  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  function io() {
    return {
      fetchFn: globalThis.fetch.bind(globalThis),
      readFileSync: (p: string) => new Uint8Array(readFileSync(p)),
      writeFileSync: (p: string, d: Uint8Array) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, d); },
      mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
      existsSync,
      renameSync,
      rmSync,
      cacheDir: cache,
      cliVersion: "0.1.0",
      signal: new AbortController().signal,
    };
  }

  const manual = "# manual\n";
  const manifest = (tier: "free" | "pro", catalogSha: string) => JSON.stringify({
    schemaVersion: 1,
    tier,
    libraryVersion: "1.2.3",
    manualVersion: "1.2.3",
    catalogVersion: "1.2.3",
    cliVersion: "0.1.0",
    generatedAt: { sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40) },
    targets: ["react", "vue", "vanilla", "assets"],
    dependencies: {},
    files: {
      "MANUAL.md": { size: Buffer.byteLength(manual), sha256: shaHex(manual) },
      "catalog.json": { size: Buffer.byteLength("{\"v\":1}\n"), sha256: shaHex("{\"v\":1}\n") },
    },
  });

  function shaHex(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  const catalogText = "{\"v\":1}\n";

  function verify(bytes: Uint8Array) {
    return extractAndVerifyMetadataArchive(bytes, {
      expectedCatalogSha: shaHex(catalogText),
      expectedTier: "free",
      expectedVersion: "1.2.3",
    });
  }

  it("accepts exactly the three frozen entries", () => {
    const archive = createTarGz({
      "metadata/MANUAL.md": manual,
      "metadata/catalog.json": catalogText,
      "metadata/manifest.json": manifest("free", shaHex(catalogText)),
    });
    const result = verify(archive);
    expect(result.kind).toBe("ok");
  });

  it("rejects an archive with an extra ordinary file", () => {
    const archive = createTarGz({
      "metadata/MANUAL.md": manual,
      "metadata/catalog.json": catalogText,
      "metadata/manifest.json": manifest("free", shaHex(catalogText)),
      "metadata/extra.txt": "sneaky",
    });
    const result = verify(archive);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("unexpected: metadata/extra.txt");
  });

  it("rejects an archive missing one frozen entry", () => {
    const archive = createTarGz({
      "metadata/MANUAL.md": manual,
      "metadata/catalog.json": catalogText,
    });
    const result = verify(archive);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("missing: metadata/manifest.json");
  });

  it("rejects an entry outside the metadata/ root", () => {
    const archive = createTarGz({
      "metadata/MANUAL.md": manual,
      "metadata/catalog.json": catalogText,
      "metadata/manifest.json": manifest("free", shaHex(catalogText)),
      "README.md": "out of root",
    });
    const result = verify(archive);
    expect(result.kind).toBe("error");
  });
});
