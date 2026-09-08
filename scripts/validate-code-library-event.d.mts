export interface CodeLibraryReleaseEvent {
  resourceVersion: string;
  sourceCommit: string;
  generatorCommit: string;
  privateDescriptorSha256: string;
  publicDescriptorSha256: string;
  freeCandidateArtifactId: string;
  upstreamRunId: string;
  correlationId: string;
}

export function validateCodeLibraryReleaseEvent(raw: unknown): CodeLibraryReleaseEvent;
