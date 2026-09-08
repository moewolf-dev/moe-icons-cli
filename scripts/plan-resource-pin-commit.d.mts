export function nextPatch(version: string): string;
export function buildPinCommitMessage(cliVersion: string, resourceVersion: string): string;
export function planPinCommit(input: {
  currentCliVersion: string;
  resourceVersion: string;
  skip?: boolean;
}): { action: string; nextCliVersion?: string; commitMessage: string; [key: string]: unknown };
export function applyPackageVersionBump(
  nextVersion: string,
  options?: { dryRun?: boolean },
): { written: string[]; [key: string]: unknown };
