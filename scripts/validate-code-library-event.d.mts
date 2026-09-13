export interface ReleaseEventBinding {
  releasePolicyCommit: string;
  releasePolicySha256: string;
  mediaContractVersion: string;
  sourceManifestSchemaVersion: string;
  releaseScope: "free" | "pro";
  bitmapBatch: {
    styleGroupIds: string[];
    variantIds: string[];
    batchId: string;
  } | null;
}

export interface CodeLibraryReleaseEvent {
  resourceVersion: string;
  sourceCommit: string;
  generatorCommit: string;
  privateDescriptorSha256: string;
  publicDescriptorSha256: string;
  freeCandidateArtifactId: string;
  upstreamRunId: string;
  correlationId: string;
  binding: ReleaseEventBinding | null;
}

export function validateEventBinding(raw: unknown): ReleaseEventBinding | null;
export function bindingMatchesPolicy(
  binding: ReleaseEventBinding | null,
  policy: { sourceCommit: string; sha256: string },
): boolean;
export function validateCodeLibraryReleaseEvent(raw: unknown): CodeLibraryReleaseEvent;
