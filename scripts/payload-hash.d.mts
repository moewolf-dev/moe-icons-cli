export type PayloadFileEntry = {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
};

export function normalizePackageJsonForPayload(pkg: Readonly<Record<string, unknown>>): Record<string, unknown>;
export function payloadFileEntries(files: Readonly<Record<string, string | Uint8Array>>): string;
export function computePayloadHash(input: {
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly lockfile?: unknown;
}): string;
export function packFilesToEntries(packFiles: readonly PayloadFileEntry[]): PayloadFileEntry[];
