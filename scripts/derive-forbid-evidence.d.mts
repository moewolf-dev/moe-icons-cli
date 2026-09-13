export function buildForbidEvidence(input: {
  freePath?: string;
  resourceReleasePath?: string;
  descriptorPath?: string;
}): {
  schemaVersion: number;
  tokens: string[];
  sha256: string;
  sources: { free: string | null; resourceRelease: string | null; descriptor: string | null };
};
