const SHA256_HEX = /^[0-9a-f]{64}$/i;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export interface ReleaseTierArtifact {
  readonly filename: string;
  readonly sha256: string;
  readonly styleGroups?: readonly string[];
  readonly styleGroupCount?: number;
}

export interface ReleaseCatalogRef {
  readonly filename: string;
  readonly sha256: string;
  readonly schemaVersion: number;
  readonly iconCount?: number;
  readonly styleGroupCount?: number;
}

export interface ReleaseDescriptor {
  readonly fullVersion: string;
  readonly free: ReleaseTierArtifact;
  readonly catalog: ReleaseCatalogRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function requireFilename(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_FILENAME.test(value)) {
    throw new Error(`${field} must be a basename without path separators`);
  }
  return value;
}

function parseTier(value: unknown, field: string): ReleaseTierArtifact {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return {
    filename: requireFilename(value.filename, `${field}.filename`),
    sha256: requireSha(value.sha256, `${field}.sha256`),
    ...(Array.isArray(value.styleGroups) && value.styleGroups.every((item) => typeof item === "string")
      ? { styleGroups: value.styleGroups }
      : {}),
    ...(typeof value.styleGroupCount === "number" ? { styleGroupCount: value.styleGroupCount } : {}),
  };
}

/** Parse release-descriptor.json. Never invent free.filename. */
export function parseReleaseDescriptor(bytes: Uint8Array): ReleaseDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("release-descriptor.json is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("release-descriptor.json must be an object");
  if (typeof parsed.fullVersion !== "string" || parsed.fullVersion.length === 0) {
    throw new Error("release-descriptor.json missing fullVersion");
  }
  if (!isRecord(parsed.catalog)) throw new Error("release-descriptor.json missing catalog");
  return {
    fullVersion: parsed.fullVersion,
    free: parseTier(parsed.free, "free"),
    catalog: {
      filename: requireFilename(parsed.catalog.filename, "catalog.filename"),
      sha256: requireSha(parsed.catalog.sha256, "catalog.sha256"),
      schemaVersion: typeof parsed.catalog.schemaVersion === "number" ? parsed.catalog.schemaVersion : 1,
      ...(typeof parsed.catalog.iconCount === "number" ? { iconCount: parsed.catalog.iconCount } : {}),
      ...(typeof parsed.catalog.styleGroupCount === "number" ? { styleGroupCount: parsed.catalog.styleGroupCount } : {}),
    },
  };
}

/** Parse `hex  filename` sidecar produced next to the descriptor. */
export function parseSha256Sidecar(text: string): string {
  const token = text.trim().split(/\s+/)[0] ?? "";
  if (!SHA256_HEX.test(token)) throw new Error("descriptor sha256 sidecar is not a 64-character hex digest");
  return token.toLowerCase();
}

export const PUBLIC_FREE_REPO = { owner: "moewolf-dev", name: "moe-icons" } as const;
export const FREE_DOWNLOAD_HOSTS = ["github.com", "objects.githubusercontent.com"] as const;

export function githubReleaseAssetUrl(tag: string, filename: string): string {
  if (!tag.startsWith("v")) throw new Error("release tag must be v<fullVersion>");
  return `https://github.com/${PUBLIC_FREE_REPO.owner}/${PUBLIC_FREE_REPO.name}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
}

export function cacheKey(fullVersion: string, sha256: string): string {
  return `${PUBLIC_FREE_REPO.owner}/${PUBLIC_FREE_REPO.name}/${fullVersion}/${sha256.toLowerCase()}`;
}
