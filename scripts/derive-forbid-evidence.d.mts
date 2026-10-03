export function buildForbidEvidence(input: {
  manifestPath?: string;
  freePath?: string;
  resourceReleasePath?: string;
  descriptorPath?: string;
}): {
  schemaVersion: number;
  tokens: string[];
  sha256: string;
  sources: { manifest: string | null; free: string | null; resourceRelease: string | null; descriptor: string | null };
};
