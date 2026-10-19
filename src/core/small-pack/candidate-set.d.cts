export interface PackageRow {
  packageSha256: string; filename: string; kind: 'bitmap' | 'svg' | 'code' | 'shared' | 'metadata' | 'website'; tier: 'free' | 'pro'; resourceKey: string; fullVersion: string;
  compressedBytes: number; expandedBytes: number; fileCount: number; dependencies: string[]; styleGroupId?: string; target?: string; variant?: { width: number; height: number; format: string }; inputSha256?: string;
}
export interface PageRef { filename: string; sha256: string; sizeBytes: number; packageCount: number }
export interface CandidateRoot { schemaVersion: number; fullVersion: string; tier: 'free' | 'pro'; sourceCommit: string; generatorCommit: string; packagePageCount: number; packagePages: PageRef[]; packageSetSha256: string }
export function canonicalBytes(value: unknown): Buffer;
export function sha256(bytes: Uint8Array): string;
export function parseCandidateSet(bytes: Uint8Array): CandidateRoot;
export function validatePackagePages(root: CandidateRoot, pages: Map<string, Uint8Array>): PackageRow[];
export function verifyPackagePayload(row: PackageRow, bytes: Uint8Array): Buffer;
export function buildCandidateSet(input: { fullVersion: string; tier: 'free' | 'pro'; sourceCommit: string; generatorCommit: string; packages: PackageRow[] }): { candidateSet: CandidateRoot; rootBytes: Buffer; pageBytesByName: Map<string, Buffer> };
