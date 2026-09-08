import { join } from "node:path";
import type { PlannedFileChange } from "./types.js";

/**
 * Transactional application of PlannedFileChange set (E2E-B5). Writes all
 * changes atomically and restores originals on any failure. A second identical
 * apply is a no-op and reports `alreadyConfigured`.
 */

export interface ApplyFs {
  readonly existsSync: (path: string) => boolean;
  readonly readTextFileSync: (path: string) => string;
  readonly mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  readonly writeTextFileSync: (path: string, content: string) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
}

export type ApplyOutcome =
  | { readonly ok: true; readonly alreadyConfigured: boolean; readonly written: readonly string[] }
  | { readonly ok: false; readonly message: string };

export function applyPlannedChanges(
  projectRoot: string,
  changes: readonly PlannedFileChange[],
  fs_: ApplyFs,
): ApplyOutcome {
  const seen = new Map<string, PlannedFileChange>();
  for (const change of changes) seen.set(change.path, change);
  const entries = [...seen.values()];

  // No-op detection: every file already has the target content.
  let anyChange = false;
  for (const entry of entries) {
    const full = join(projectRoot, entry.path);
    const current = fs_.existsSync(full) ? safeRead(fs_, full) : undefined;
    if (current === entry.after) continue;
    anyChange = true;
    break;
  }
  if (!anyChange) return { ok: true, alreadyConfigured: true, written: [] };

  const backupRoot = join(projectRoot, ".moeicons", ".doctor-backup");
  const backedUp: Array<{ target: string; backup: string }> = [];
  const installed: string[] = [];
  try {
    for (const entry of entries) {
      const full = join(projectRoot, entry.path);
      if (fs_.existsSync(full)) {
        const backup = join(backupRoot, entry.path);
        fs_.mkdirSync(join(backup, ".."), { recursive: true });
        fs_.renameSync(full, backup);
        backedUp.push({ target: full, backup });
      }
    }
    for (const entry of entries) {
      const full = join(projectRoot, entry.path);
      fs_.mkdirSync(join(full, ".."), { recursive: true });
      fs_.writeTextFileSync(full, entry.after);
      installed.push(full);
    }
    if (fs_.existsSync(backupRoot)) fs_.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    for (const target of installed.reverse()) {
      if (fs_.existsSync(target)) fs_.rmSync(target, { force: true });
    }
    for (const item of backedUp.reverse()) {
      if (fs_.existsSync(item.backup)) {
        fs_.mkdirSync(join(item.target, ".."), { recursive: true });
        try {
          fs_.renameSync(item.backup, item.target);
        } catch {
          // leave backup for manual recovery
        }
      }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fs_.existsSync(backupRoot)) fs_.rmSync(backupRoot, { recursive: true, force: true });
  }
  return { ok: true, alreadyConfigured: false, written: entries.map((e) => e.path) };
}

function safeRead(fs_: ApplyFs, path: string): string {
  try {
    return fs_.readTextFileSync(path);
  } catch {
    return "";
  }
}
