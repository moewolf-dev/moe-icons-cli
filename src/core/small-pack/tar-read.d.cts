export interface TarEntry { path: string; type: string; linkname: string | null; size: number; data: Buffer | null }
export function readTarEntries(bytes: Uint8Array, limits: { maxEntries: number; maxExpandedBytes: number }): TarEntry[];
