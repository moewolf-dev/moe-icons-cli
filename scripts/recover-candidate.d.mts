export function lookupOrAbsent(input: {
  run: (args: string[]) => { ok: boolean; stdout?: string; stderr?: string; message?: string };
  args: string[];
  label: string;
  retries?: number;
}): { exists: boolean; value?: any };
export function runGh(gh: (args: string[]) => string, args: string[]): { ok: boolean; stdout?: string; stderr?: string; message?: string };
export function verifyRecoveryIdentity(input: any): { acceptanceJob: string; version: string; payloadHash: string };
