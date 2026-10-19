export function validatePackageSetEvent(event: Record<string, unknown>): Record<string, unknown>;
export function buildPackageSetResourceRelease(event: Record<string, any>, catalogSha256: string, appliedAt: string): Record<string, any>;
export function applyPackageSetPin(input: {
  event: Record<string, any>;
  catalog: Record<string, any>;
  catalogSha256: string;
  dryRun?: boolean;
  nowIso?: string;
  rootDir?: string;
  currentRelease?: Record<string, any> | null;
}): Record<string, any>;
