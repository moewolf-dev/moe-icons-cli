export type Tier = "free" | "pro";

interface ParsedVersion { major: number; minor: number; patch: number; channel: "stable" | "alpha" | "beta" }
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta))?$/;

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), channel: (match[4] as "alpha" | "beta" | undefined) ?? "stable" };
}

export type UpdateDecision =
  | { readonly kind: "update" }
  | { readonly kind: "current" }
  | { readonly kind: "refuse"; readonly reason: "tier-mismatch" | "channel-mismatch" | "downgrade" | "invalid-version" };

export function decideUpdate(input: { installedTier: Tier; remoteTier: Tier; installedVersion: string; remoteVersion: string }): UpdateDecision {
  if (input.installedTier !== input.remoteTier) return { kind: "refuse", reason: "tier-mismatch" };
  const local = parseVersion(input.installedVersion);
  const remote = parseVersion(input.remoteVersion);
  if (!local || !remote) return { kind: "refuse", reason: "invalid-version" };
  if (local.channel !== remote.channel) return { kind: "refuse", reason: "channel-mismatch" };
  const comparison = remote.major - local.major || remote.minor - local.minor || remote.patch - local.patch;
  if (comparison === 0) return { kind: "current" };
  return comparison > 0 ? { kind: "update" } : { kind: "refuse", reason: "downgrade" };
}

export interface UpdateCandidateIdentity { readonly tier: Tier; readonly version: string; readonly descriptorSha256: string; readonly artifactSha256: string }

/** Recheck the downloaded candidate immediately before commit to prevent TOCTOU. */
export function verifyCandidateIdentity(expected: UpdateCandidateIdentity, actual: UpdateCandidateIdentity): boolean {
  return expected.tier === actual.tier && expected.version === actual.version &&
    expected.descriptorSha256 === actual.descriptorSha256 && expected.artifactSha256 === actual.artifactSha256 &&
    /^[a-f0-9]{64}$/.test(actual.descriptorSha256) && /^[a-f0-9]{64}$/.test(actual.artifactSha256);
}
