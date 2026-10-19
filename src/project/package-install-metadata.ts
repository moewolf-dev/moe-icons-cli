import { canonicalBytes } from "../core/small-pack/candidate-set.cjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(?:0|[1-9]\d*))?)?$/;
const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TARGETS = new Set(["react", "vue", "vanilla", "assets"]);
const RESOURCE_KEY = /^(?:metadata\/(?:free|pro)\/(?:common|moe-[a-z0-9]+(?:-[a-z0-9]+)*)|code\/(?:free|pro)\/(?:react|vue|vanilla)\/moe-[a-z0-9]+(?:-[a-z0-9]+)*|shared\/(?:free|pro)\/(?:react|vue|vanilla)|svg\/(?:free|pro)\/moe-[a-z0-9]+(?:-[a-z0-9]+)*|bitmap\/(?:free|pro)\/moe-[a-z0-9]+(?:-[a-z0-9]+)*\/[1-9]\d*x[1-9]\d*\/(?:png|webp))$/;

export interface PackageInstallCandidateIdentity {
  readonly schemaVersion: 1;
  readonly tier: "free" | "pro";
  readonly fullVersion: string;
  readonly sourceCommit: string;
  readonly generatorCommit: string;
  readonly packageSetSha256: string;
  readonly candidateRootSha256: string;
}

export interface PackageInstallPin {
  readonly resourceKey: string;
  readonly packageSha256: string;
  readonly dependencies: readonly string[];
}

/** Identity for selected package installs; intentionally has no archive digest field. */
export interface PackageInstallMetadata {
  readonly schemaVersion: 2;
  readonly candidate: PackageInstallCandidateIdentity;
  readonly target: "react" | "vue" | "vanilla" | "assets";
  readonly resourceKeys: readonly string[];
  readonly packages: readonly PackageInstallPin[];
  readonly catalogSha256: string;
  readonly installedAt: string;
  readonly managedFiles: Readonly<Record<string, string>>;
  readonly targetSha256: string;
  readonly targetFileCount: number;
  readonly targetByteCount: number;
  readonly generatedOutputDir?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeManagedPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..") &&
    ![".git", "node_modules"].includes(path.split("/")[0]!.toLowerCase());
}

function onlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function sortedUniqueStrings(value: unknown, pattern?: RegExp): value is string[] {
  if (!Array.isArray(value)) return false;
  const strings: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || (pattern && !pattern.test(entry))) return false;
    strings.push(entry);
  }
  return new Set(strings).size === strings.length && strings.every((entry, index) => index === 0 || strings[index - 1]!.localeCompare(entry, "en") < 0);
}

export function parsePackageInstallMetadata(raw: string): PackageInstallMetadata | undefined {
  try {
    const bytes = Buffer.from(raw, "utf8");
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.schemaVersion !== 2 || !bytes.equals(canonicalBytes(value))) return undefined;
    if (!onlyKeys(value, ["schemaVersion", "candidate", "target", "resourceKeys", "packages", "catalogSha256", "installedAt", "managedFiles", "targetSha256", "targetFileCount", "targetByteCount"], ["generatedOutputDir"])) return undefined;
    const candidate = value.candidate;
    if (!record(candidate) || !onlyKeys(candidate, ["schemaVersion", "tier", "fullVersion", "sourceCommit", "generatorCommit", "packageSetSha256", "candidateRootSha256"])) return undefined;
    if (candidate.schemaVersion !== 1 || (candidate.tier !== "free" && candidate.tier !== "pro") || typeof candidate.fullVersion !== "string" || !VERSION.test(candidate.fullVersion) ||
      typeof candidate.sourceCommit !== "string" || !COMMIT.test(candidate.sourceCommit) || typeof candidate.generatorCommit !== "string" || !COMMIT.test(candidate.generatorCommit) ||
      typeof candidate.packageSetSha256 !== "string" || !SHA256.test(candidate.packageSetSha256) || typeof candidate.candidateRootSha256 !== "string" || !SHA256.test(candidate.candidateRootSha256)) return undefined;
    if (typeof value.target !== "string" || !TARGETS.has(value.target)) return undefined;
    const targetMatchesKey = (key: string): boolean => {
      const [kind, , target] = key.split("/");
      if (kind === "code" || kind === "shared") return target === value.target;
      if (kind === "svg") return value.target === "assets" || value.target === "vanilla";
      if (kind === "bitmap") return value.target !== "vanilla";
      return kind === "metadata";
    };
    if (!sortedUniqueStrings(value.resourceKeys, RESOURCE_KEY) || value.resourceKeys.length === 0 || value.resourceKeys.some((key) => key.split("/")[1] !== candidate.tier || !targetMatchesKey(key))) return undefined;
    if (!Array.isArray(value.packages) || value.packages.length === 0) return undefined;
    const packages: PackageInstallPin[] = [];
    for (const entry of value.packages) {
      if (!record(entry) || !onlyKeys(entry, ["resourceKey", "packageSha256", "dependencies"]) ||
        typeof entry.resourceKey !== "string" || !RESOURCE_KEY.test(entry.resourceKey) || entry.resourceKey.split("/")[1] !== candidate.tier || !targetMatchesKey(entry.resourceKey) ||
        typeof entry.packageSha256 !== "string" || !SHA256.test(entry.packageSha256) || !sortedUniqueStrings(entry.dependencies, SHA256) || entry.dependencies.includes(entry.packageSha256)) return undefined;
      packages.push(entry as unknown as PackageInstallPin);
    }
    if (!packages.every((entry, index) => index === 0 || packages[index - 1]!.resourceKey.localeCompare(entry.resourceKey, "en") < 0)) return undefined;
    const packageKeys = new Set(packages.map((entry) => entry.resourceKey));
    const packageDigests = new Set(packages.map((entry) => entry.packageSha256));
    if (packageDigests.size !== packages.length || value.resourceKeys.some((key) => !packageKeys.has(key)) || packages.some((entry) => entry.dependencies.some((digest) => !packageDigests.has(digest)))) return undefined;
    if (typeof value.catalogSha256 !== "string" || !SHA256.test(value.catalogSha256) || typeof value.targetSha256 !== "string" || !SHA256.test(value.targetSha256)) return undefined;
    if (!Number.isSafeInteger(value.targetFileCount) || Number(value.targetFileCount) < 1 || !Number.isSafeInteger(value.targetByteCount) || Number(value.targetByteCount) < 0) return undefined;
    if (typeof value.installedAt !== "string" || !UTC_RFC3339.test(value.installedAt) || Number.isNaN(Date.parse(value.installedAt))) return undefined;
    if (!record(value.managedFiles) || Object.keys(value.managedFiles).length === 0) return undefined;
    const managedFiles = value.managedFiles;
    const managedPaths = Object.keys(managedFiles);
    if (managedPaths.some((path) => !safeManagedPath(path)) || new Set(managedPaths.map((path) => path.toLowerCase())).size !== managedPaths.length ||
      Object.values(managedFiles).some((hash) => typeof hash !== "string" || !SHA256.test(hash)) || managedFiles[".moeicons/catalog.json"] !== value.catalogSha256) return undefined;
    if (typeof value.generatedOutputDir !== "undefined" && (typeof value.generatedOutputDir !== "string" || !safeManagedPath(value.generatedOutputDir))) return undefined;
    return value as unknown as PackageInstallMetadata;
  } catch {
    return undefined;
  }
}

export function serializePackageInstallMetadata(metadata: PackageInstallMetadata): string {
  return canonicalBytes(metadata).toString("utf8");
}
