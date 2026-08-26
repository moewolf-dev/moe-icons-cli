import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta))?$/;
const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface InstallMetadata {
  readonly schemaVersion: 1;
  readonly artifactVersion: string;
  readonly tier: "free" | "pro";
  readonly target: "react" | "vue" | "vanilla" | "assets";
  readonly descriptorSha256: string;
  readonly artifactSha256: string;
  readonly catalogSha256: string;
  readonly installedAt: string;
  readonly managedFiles: Readonly<Record<string, string>>;
  /** Verified target subtree hash/size recorded at install time. */
  readonly targetSha256?: string;
  readonly targetFileCount?: number;
  readonly targetByteCount?: number;
}

export type InstalledResourceState =
  | { readonly kind: "ok"; readonly metadata: InstallMetadata }
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string };

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeManagedPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

export function parseInstallMetadata(raw: string): InstallMetadata | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const allowed = new Set([
      "schemaVersion",
      "artifactVersion",
      "tier",
      "target",
      "descriptorSha256",
      "artifactSha256",
      "catalogSha256",
      "installedAt",
      "managedFiles",
      "targetSha256",
      "targetFileCount",
      "targetByteCount",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || value.schemaVersion !== 1)
      return undefined;
    if (typeof value.artifactVersion !== "string" || !VERSION.test(value.artifactVersion))
      return undefined;
    if (value.tier !== "free" && value.tier !== "pro") return undefined;
    if (!["react", "vue", "vanilla", "assets"].includes(value.target as string))
      return undefined;
    if (typeof value.descriptorSha256 !== "string" || !SHA256.test(value.descriptorSha256))
      return undefined;
    if (typeof value.artifactSha256 !== "string" || !SHA256.test(value.artifactSha256))
      return undefined;
    if (typeof value.catalogSha256 !== "string" || !SHA256.test(value.catalogSha256))
      return undefined;
    if (
      value.targetSha256 !== undefined &&
      (typeof value.targetSha256 !== "string" || !SHA256.test(value.targetSha256))
    )
      return undefined;
    if (
      value.targetFileCount !== undefined &&
      (typeof value.targetFileCount !== "number" || !Number.isSafeInteger(value.targetFileCount))
    )
      return undefined;
    if (
      value.targetByteCount !== undefined &&
      (typeof value.targetByteCount !== "number" || !Number.isSafeInteger(value.targetByteCount))
    )
      return undefined;
    if (
      typeof value.installedAt !== "string" ||
      !UTC_RFC3339.test(value.installedAt) ||
      Number.isNaN(Date.parse(value.installedAt))
    )
      return undefined;
    if (
      typeof value.managedFiles !== "object" ||
      value.managedFiles === null ||
      Array.isArray(value.managedFiles)
    )
      return undefined;
    const managedFiles = value.managedFiles as Record<string, unknown>;
    if (
      Object.keys(managedFiles).length === 0 ||
      Object.entries(managedFiles).some(
        ([path, hash]) => !safeManagedPath(path) || typeof hash !== "string" || !SHA256.test(hash),
      )
    )
      return undefined;
    return value as unknown as InstallMetadata;
  } catch {
    return undefined;
  }
}

export function serializeInstallMetadata(metadata: InstallMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function readInstalledResourceState(
  projectRoot: string,
  expectedTier?: "free" | "pro",
): InstalledResourceState {
  const metadataPath = join(projectRoot, ".moeicons", "install-metadata.json");
  if (!existsSync(metadataPath))
    return {
      kind: "missing",
      message: "managed install metadata is missing; run repair or reinstall",
    };
  const metadata = parseInstallMetadata(readFileSync(metadataPath, "utf8"));
  if (!metadata)
    return {
      kind: "invalid",
      message: "managed install metadata is invalid; run repair or reinstall",
    };
  if (expectedTier && metadata.tier !== expectedTier)
    return {
      kind: "invalid",
      message: `installed tier ${metadata.tier} does not match config tier ${expectedTier}`,
    };
  for (const [relative, expectedHash] of Object.entries(metadata.managedFiles)) {
    const path = join(projectRoot, relative);
    if (!existsSync(path))
      return { kind: "invalid", message: `managed file is missing: ${relative}` };
    const actual = sha256Bytes(readFileSync(path));
    if (actual !== expectedHash)
      return { kind: "invalid", message: `managed file was modified: ${relative}` };
  }
  const catalogHash = metadata.managedFiles[".moeicons/catalog.json"];
  if (!catalogHash || catalogHash !== metadata.catalogSha256)
    return { kind: "invalid", message: "catalog hash does not match managed metadata" };
  return { kind: "ok", metadata };
}
