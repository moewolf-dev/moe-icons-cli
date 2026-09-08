import type { CodeLibraryReleaseEvent } from "./validate-code-library-event.mjs";

export interface ResourceRelease {
  resourceVersion: string;
  sourceCommit: string;
  generatorCommit: string;
  privateDescriptorSha256: string;
  publicDescriptorSha256: string;
  freeCandidateArtifactId: string;
  catalogSha256: string;
  appliedAt: string;
  [key: string]: unknown;
}

export function buildResourceRelease(
  event: CodeLibraryReleaseEvent,
  options?: { catalogSha256?: string; appliedAt?: string },
): ResourceRelease;
export function shouldSkipPin(existingRelease: ResourceRelease | undefined, event: CodeLibraryReleaseEvent): boolean;
export function assertAllowedPinDiff(changedPaths: string[]): void;
export function applyResourcePin(input: {
  event: CodeLibraryReleaseEvent;
  catalog: Record<string, unknown>;
  catalogSha256?: string;
  dryRun?: boolean;
  nowIso?: string;
}): { action: string; dryRun: boolean; written: string[]; [key: string]: unknown };
