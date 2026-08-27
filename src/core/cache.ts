import { createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";

/**
 * Minimal filesystem surface needed for atomic, concurrency-safe cache
 * persistence. Matches the project install transaction contract: verified
 * bytes are written to a writer-unique sibling staging file and `renameSync`'d
 * over the final path, so readers never observe a truncated cache and a crash
 * never leaves a partial cache at the final path.
 */
export interface CacheIo {
  readonly mkdirSync: (path: string) => void;
  readonly writeFileSync: (path: string, bytes: Uint8Array) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly existsSync: (path: string) => boolean;
  readonly rmSync: (path: string, options?: { readonly force?: boolean }) => void;
  readonly readFileSync?: (path: string) => Uint8Array;
  readonly readdirSync?: (path: string) => readonly string[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Atomically persist verified bytes to a cache path.
 *
 * Concurrency contract (MC.5): every writer uses a PID + random suffixed
 * staging file, so concurrent processes never share a staging file; the final
 * rename is atomic on POSIX and Node uses `MOVEFILE_REPLACE_EXISTING` on
 * Windows. When `expectedSha256` is provided and the final path already holds
 * exactly those bytes, the write is skipped (idempotent fast path), so a second
 * writer that lost the rename race reports success without rewriting.
 *
 * Staging files left behind by a crashed writer are inert (never read) and are
 * swept on the next successful write for the same path — only pre-existing
 * orphans are removed, so a concurrent writer's fresh staging file is never
 * deleted.
 */
export function cacheArtifact(
  io: CacheIo,
  path: string,
  bytes: Uint8Array,
  expectedSha256?: string,
): void {
  io.mkdirSync(join(path, ".."));
  const orphans = new Set(io.readdirSync ? io.readdirSync(join(path, "..")) : []);
  const stagingPattern = `${basename(path)}.staging-`;

  if (expectedSha256 && io.existsSync(path) && io.readFileSync) {
    const existing = io.readFileSync(path);
    if (existing.byteLength === bytes.byteLength && sha256Hex(existing) === expectedSha256) {
      return;
    }
  }

  const staging = `${path}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    io.writeFileSync(staging, bytes);
    try {
      io.renameSync(staging, path);
    } catch (error) {
      // Cross-process race: another writer may have replaced `path` first. Only
      // treat that as success when the surviving bytes actually match what we
      // set out to persist; otherwise rethrow so a corrupt cache is not kept.
      if (expectedSha256 && io.existsSync(path) && io.readFileSync) {
        const existing = io.readFileSync(path);
        if (existing.byteLength === bytes.byteLength && sha256Hex(existing) === expectedSha256) {
          return;
        }
      }
      throw error;
    }
    if (io.rmSync && io.readdirSync) {
      for (const name of orphans) {
        if (!name.startsWith(stagingPattern)) continue;
        try {
          io.rmSync(join(join(path, ".."), name), { force: true });
        } catch {
          // Best-effort orphan sweep.
        }
      }
    }
  } catch (error) {
    try {
      io.rmSync(staging, { force: true });
    } catch {
      // Best-effort cleanup; the writer-unique staging file is never read.
    }
    throw error;
  }
}
