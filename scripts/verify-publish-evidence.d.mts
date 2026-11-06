export interface PublishEvidence {
  schemaVersion?: number;
  version?: string;
  tag?: string;
  stage?: string;
  pinCommit?: string;
  candidateSha256?: string;
  npmIntegrity?: string;
}

export function verifyPublishEvidence(input: {
  intent: PublishEvidence;
  accepted: PublishEvidence;
  tag: string;
  candidate: string;
  pin: string;
  requireAccepted?: boolean;
}): { version: string; tag: string; pinCommit: string; stage: string };
