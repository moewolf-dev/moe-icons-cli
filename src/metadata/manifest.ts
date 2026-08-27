import type { ReleaseTarget } from "../core/release-descriptor.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_TARGETS = ["react", "vue", "vanilla", "assets"] as const;

export interface MetadataFileDigest {
  readonly size: number;
  readonly sha256: string;
}

export interface MetadataManifest {
  readonly schemaVersion: 1;
  readonly tier: "free" | "pro";
  readonly libraryVersion: string;
  readonly manualVersion: string;
  readonly catalogVersion: string;
  readonly cliVersion: string;
  readonly generatedAt: {
    readonly sourceCommit: string;
    readonly generatorCommit: string;
  };
  readonly targets: readonly ReleaseTarget[];
  readonly dependencies: Readonly<Partial<Record<ReleaseTarget, Readonly<Record<string, string>>>>>;
  readonly files: {
    readonly "MANUAL.md": MetadataFileDigest;
    readonly "catalog.json": MetadataFileDigest;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFileDigest(value: unknown, field: string): MetadataFileDigest {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1) {
    throw new Error(`${field}.size must be a positive integer`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256)) {
    throw new Error(`${field}.sha256 must be a 64-char sha256 hex`);
  }
  return { size: value.size, sha256: value.sha256.toLowerCase() };
}

/**
 * Strict parse of a metadata manifest. Unknown fields, unknown schemaVersion,
 * a tier/version/hash mismatch or malformed file digests are hard errors.
 */
export function parseMetadataManifest(raw: string | Uint8Array): MetadataManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("manifest.json must be an object");

  const allowed = new Set([
    "schemaVersion",
    "tier",
    "libraryVersion",
    "manualVersion",
    "catalogVersion",
    "cliVersion",
    "generatedAt",
    "targets",
    "dependencies",
    "files",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new Error(`manifest.json has an unknown field: ${key}`);
  }
  if (parsed.schemaVersion !== 1) throw new Error(`unsupported manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  if (parsed.tier !== "free" && parsed.tier !== "pro") {
    throw new Error(`manifest.json has an invalid tier: ${String(parsed.tier)}`);
  }
  for (const field of ["libraryVersion", "manualVersion", "catalogVersion", "cliVersion"]) {
    if (typeof parsed[field] !== "string" || !VERSION.test(parsed[field])) {
      throw new Error(`manifest.json ${field} must be a valid semver string`);
    }
  }
  if (!isRecord(parsed.generatedAt)) throw new Error("manifest.json generatedAt must be an object");
  const generatedAt = parsed.generatedAt;
  for (const field of ["sourceCommit", "generatorCommit"]) {
    if (typeof generatedAt[field] !== "string" || !COMMIT.test(generatedAt[field])) {
      throw new Error(`manifest.json generatedAt.${field} must be a 40-char commit sha`);
    }
  }
  if (
    !Array.isArray(parsed.targets) ||
    parsed.targets.length === 0 ||
    !parsed.targets.every((target) => (RELEASE_TARGETS as readonly string[]).includes(target as string))
  ) {
    throw new Error("manifest.json targets must be a non-empty array of release targets");
  }
  const targets = parsed.targets as readonly ReleaseTarget[];
  if (!isRecord(parsed.dependencies)) throw new Error("manifest.json dependencies must be an object");
  const dependencies: Record<ReleaseTarget, Readonly<Record<string, string>>> = {
    react: {},
    vue: {},
    vanilla: {},
    assets: {},
  };
  for (const [target, value] of Object.entries(parsed.dependencies)) {
    if (!(RELEASE_TARGETS as readonly string[]).includes(target)) {
      throw new Error(`manifest.json has an unknown target dependency: ${target}`);
    }
    if (!isRecord(value)) throw new Error(`manifest.json dependencies.${target} must be an object`);
    dependencies[target as ReleaseTarget] = Object.fromEntries(
      Object.entries(value).map(([name, range]) => [name, String(range)]),
    );
  }
  if (!isRecord(parsed.files)) throw new Error("manifest.json files must be an object");
  const files: MetadataManifest["files"] = {
    "MANUAL.md": parseFileDigest(parsed.files["MANUAL.md"], "files.MANUAL.md"),
    "catalog.json": parseFileDigest(parsed.files["catalog.json"], "files.catalog.json"),
  };
  for (const key of Object.keys(parsed.files)) {
    if (key !== "MANUAL.md" && key !== "catalog.json") {
      throw new Error(`manifest.json files has an unknown entry: ${key}`);
    }
  }
  return {
    schemaVersion: 1,
    tier: parsed.tier,
    libraryVersion: parsed.libraryVersion as string,
    manualVersion: parsed.manualVersion as string,
    catalogVersion: parsed.catalogVersion as string,
    cliVersion: parsed.cliVersion as string,
    generatedAt: {
      sourceCommit: generatedAt.sourceCommit as string,
      generatorCommit: generatedAt.generatorCommit as string,
    },
    targets,
    dependencies,
    files,
  };
}
