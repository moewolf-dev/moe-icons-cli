import { gzipSync } from "node:zlib";
import { sha256Bytes } from "../../src/project/install-metadata.js";
import type { ResourceIndex, ResourceRefs } from "../../src/core/selected-resources.js";
export function selectedFixture(
  input: Record<string, string | Uint8Array>,
  requires: Record<string, string[]> = {},
  tier: "free" | "pro" = "free",
  version = "0.0.18",
  parent = "a".repeat(64),
) {
  const files: Record<string, ResourceIndex["files"][string]> = {};
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const name of Object.keys(input).sort()) {
    const bytes =
      typeof input[name] === "string" ? Buffer.from(input[name]) : (input[name] as Uint8Array);
    const zipped = gzipSync(bytes);
    files[name] = {
      offset,
      compressedSize: zipped.length,
      compressedSha256: sha256Bytes(zipped),
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      requires: requires[name] ?? [],
    };
    offset += zipped.length;
    chunks.push(zipped);
  }
  const bundle = Buffer.concat(chunks);
  const bundleRef = {
    filename: `moe-icons-${tier}-resources-${version}.bin`,
    size: bundle.length,
    sha256: sha256Bytes(bundle),
  };
  const index: ResourceIndex = {
    schemaVersion: 1,
    version,
    tier,
    artifactSha256: parent,
    bundle: bundleRef,
    files,
  };
  const indexBytes = gzipSync(Buffer.from(JSON.stringify(index)));
  const refs: ResourceRefs = {
    schemaVersion: 1,
    index: {
      filename: `moe-icons-${tier}-resource-index-${version}.json.gz`,
      size: indexBytes.length,
      sha256: sha256Bytes(indexBytes),
    },
    bundle: bundleRef,
  };
  return { index, indexBytes, refs, bundle };
}
