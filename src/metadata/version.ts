const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta))?$/;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly channel: "stable" | "alpha" | "beta";
}

export function parseVersion(value: string): ParsedVersion {
  const match = VERSION.exec(value);
  if (!match) throw new Error(`invalid version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    channel: match[4] === "alpha" ? "alpha" : match[4] === "beta" ? "beta" : "stable",
  };
}

/** Three-way semver comparison; never string-dictionary compares prerelease tags. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  const channelRank = (channel: ParsedVersion["channel"]): number =>
    channel === "alpha" ? 0 : channel === "beta" ? 1 : 2;
  const l = channelRank(left.channel);
  const r = channelRank(right.channel);
  if (l !== r) return l < r ? -1 : 1;
  return 0;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * Per-resource version state for code and metadata. Distinguishes a CLI that is
 * too old to consume the remote (incompatible), a corrupt local install, and a
 * plain missing/current/update state.
 */
export type ResourceStatus =
  | "missing"
  | "current"
  | "update-available"
  | "incompatible"
  | "corrupt";

export function cliCompatible(minRequiredCli: string, cliVersion: string): boolean {
  try {
    return compareVersions(cliVersion, minRequiredCli) >= 0;
  } catch {
    return false;
  }
}

/**
 * Format a byte count for user-facing size hints (MiB, 1024-based, one decimal;
 * KiB/B below one MiB). Frozen contract shared by the free and pro flows.
 */
export function formatBytes(bytes: number): string {
  const kib = 1024;
  const mib = kib * 1024;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
  if (bytes >= kib) return `${(bytes / kib).toFixed(1)} KiB`;
  return `${bytes} B`;
}
