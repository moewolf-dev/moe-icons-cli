export function scanBundleForForbidden(
  bytes: Uint8Array,
  forbiddenTokens: string[],
  forbidPrefixes?: string[],
): { ok: boolean; hits: string[]; scannedTokens: number };

export function deriveForbiddenTokens(input: {
  manifest?: unknown;
  descriptor?: unknown;
  freeGroups?: string[];
  resourceRelease?: unknown;
}): string[];

export function bundleSha256(bytes: Uint8Array): string;
