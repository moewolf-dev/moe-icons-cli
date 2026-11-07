export interface PublishIntent {
  version?: string;
  tag?: string;
  candidateSha256?: string;
  pinCommit?: string;
  stage?: string;
}

export function decideRelease(input: {
  intentStatus: "found" | "missing" | "failed";
  intent?: PublishIntent;
  registry?: string;
  candidateSha256?: string;
  nextVersion?: string;
  payloadHash?: string;
  lastPublishedPayloadHash?: string;
}): {
  shouldRelease: boolean;
  nextVersion?: string;
  resume?: boolean;
  reuseReason?: string;
  registry?: string;
};
