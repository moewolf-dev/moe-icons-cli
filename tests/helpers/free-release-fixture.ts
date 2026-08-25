import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTarGz } from "../../src/project/tar-gz.js";
import { bundledSourceVersion, DESCRIPTOR_NAME, DESCRIPTOR_SHA_NAME } from "../../src/core/free-download.js";

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Write a GitHub-Release-shaped free fixture directory for E1/E2 tests. */
export function writeFreeReleaseFixture(
  dir: string,
  options: { readonly corruptArtifact?: boolean; readonly wrongDescriptorSha?: boolean; readonly version?: string; readonly useBundledCatalog?: boolean } = {},
): {
  readonly version: string;
  readonly freeName: string;
  readonly descriptorSha: string;
  readonly freeSha: string;
  readonly catalogSha: string;
} {
  const version = options.version ?? bundledSourceVersion();
  const catalog = options.useBundledCatalog
    ? `${JSON.stringify({ ...JSON.parse(readFileSync(join(import.meta.dirname, "../../src/catalog/catalog.json"), "utf8")), catalogVersion: version, sourceVersion: version })}\n`
    : JSON.stringify({
    schemaVersion: 1,
    catalogVersion: version,
    sourceVersion: version,
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [],
    icons: [],
    });
  const catalogSha = sha256(catalog);
  const tgz = createTarGz({ "catalog.json": catalog });
  const freeSha = sha256(tgz);
  const freeName = `moe-icons-free-${version}.tgz`;
  const descriptor = {
    fullVersion: version,
    free: { filename: freeName, sha256: freeSha, styleGroups: ["moe-outline"], styleGroupCount: 1 },
    catalog: { filename: "catalog.json", sha256: catalogSha, schemaVersion: 1, iconCount: 0, styleGroupCount: 0 },
  };
  const descriptorJson = `${JSON.stringify(descriptor, null, 2)}\n`;
  const descriptorSha = sha256(descriptorJson);
  writeFileSync(join(dir, DESCRIPTOR_NAME), descriptorJson);
  writeFileSync(
    join(dir, DESCRIPTOR_SHA_NAME),
    `${options.wrongDescriptorSha ? "f".repeat(64) : descriptorSha}  ${DESCRIPTOR_NAME}\n`,
  );
  writeFileSync(join(dir, freeName), options.corruptArtifact ? Buffer.from("not-a-tgz") : Buffer.from(tgz));
  return { version, freeName, descriptorSha, freeSha, catalogSha };
}
