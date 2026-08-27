import { createHash } from "node:crypto";
import { extractTarGz, decodeUtf8 } from "../project/tar-gz.js";
import { parseMetadataManifest, type MetadataFileDigest } from "./manifest.js";

export const METADATA_ARCHIVE_ENTRIES = ["MANUAL.md", "catalog.json", "manifest.json"] as const;

/** Exact archive layout the contract requires: nothing more, nothing less. */
const ALLOWED_ENTRIES = new Set(
  METADATA_ARCHIVE_ENTRIES.map((name) => `metadata/${name}`),
);

export interface MetadataArchiveFiles {
  readonly manifestJson: string;
  readonly manualMd: string;
  readonly catalogJson: string;
}

export type MetadataArchiveVerification =
  | {
      readonly expectedCatalogSha: string;
      readonly expectedTier: "free" | "pro";
      readonly expectedVersion: string;
      /** Free path: the release descriptor provides per-file size + sha256. */
      readonly perFileDigests: Readonly<Record<(typeof METADATA_ARCHIVE_ENTRIES)[number], MetadataFileDigest>>;
    }
  | {
      readonly expectedCatalogSha: string;
      readonly expectedTier: "free" | "pro";
      readonly expectedVersion: string;
      /** Pro path: the signed whole-archive sha256 was already verified. */
      readonly perFileDigests?: undefined;
    };

export type MetadataArchiveResult =
  | { readonly kind: "ok"; readonly value: MetadataArchiveFiles }
  | { readonly kind: "error"; readonly reason: "validation" | "checksum-mismatch"; readonly message: string };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256HexOfString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Single implementation for unpacking + verifying a tier metadata archive.
 * Free/Pro share the whole flow; they only differ in whether per-file digests
 * are available (free descriptor) or the whole archive was already verified by
 * its signed sha256 (pro).
 */
export function extractAndVerifyMetadataArchive(
  bytes: Uint8Array,
  verification: MetadataArchiveVerification,
  maxExpandedBytes = 8 * 1024 * 1024,
): MetadataArchiveResult {
  const unpacked = extractTarGz(bytes, { maxEntries: 20_000, maxExpandedBytes });
  if (unpacked.errors.length > 0) {
    return { kind: "error", reason: "validation", message: unpacked.errors[0] ?? "metadata archive extract failed" };
  }
  // Strict whitelist: the archive must contain exactly the three frozen entries.
  const actual = new Set(Object.keys(unpacked.files));
  if (actual.size !== ALLOWED_ENTRIES.size || [...actual].some((name) => !ALLOWED_ENTRIES.has(name))) {
    const extra = [...actual].filter((name) => !ALLOWED_ENTRIES.has(name));
    const missing = [...ALLOWED_ENTRIES].filter((name) => !actual.has(name));
    return {
      kind: "error",
      reason: "validation",
      message: `metadata archive must contain exactly the frozen files${
        extra.length ? `; unexpected: ${extra.join(", ")}` : ""
      }${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    };
  }
  let manifestJson = "";
  let manualMd = "";
  let catalogJson = "";
  for (const name of METADATA_ARCHIVE_ENTRIES) {
    const raw = unpacked.files[`metadata/${name}`]!;
    const digest = verification.perFileDigests?.[name];
    if (digest && (sha256Hex(raw) !== digest.sha256 || raw.byteLength !== digest.size)) {
      return {
        kind: "error",
        reason: "checksum-mismatch",
        message: `metadata/${name} digest mismatch: expected ${digest.sha256}, got ${sha256Hex(raw)}`,
      };
    }
    const text = decodeUtf8(raw);
    if (name === "MANUAL.md") manualMd = text;
    else if (name === "catalog.json") catalogJson = text;
    else manifestJson = text;
  }
  if (sha256HexOfString(catalogJson) !== verification.expectedCatalogSha) {
    return {
      kind: "error",
      reason: "checksum-mismatch",
      message: "metadata catalog.json does not match the code archive catalog",
    };
  }
  let manifest;
  try {
    manifest = parseMetadataManifest(manifestJson);
  } catch (error) {
    return { kind: "error", reason: "validation", message: error instanceof Error ? error.message : String(error) };
  }
  if (manifest.tier !== verification.expectedTier) {
    return {
      kind: "error",
      reason: "validation",
      message: `manifest tier ${manifest.tier} does not match ${verification.expectedTier}`,
    };
  }
  if (manifest.libraryVersion !== verification.expectedVersion) {
    return {
      kind: "error",
      reason: "validation",
      message: `manifest libraryVersion ${manifest.libraryVersion} does not match release ${verification.expectedVersion}`,
    };
  }
  if (manifest.files["catalog.json"].sha256 !== verification.expectedCatalogSha) {
    return {
      kind: "error",
      reason: "checksum-mismatch",
      message: "manifest catalog digest does not match the code archive catalog",
    };
  }
  return { kind: "ok", value: { manifestJson, manualMd, catalogJson } };
}
