import { realpathSync, readdirSync, copyFileSync, type existsSync, type mkdirSync, type readFileSync, type renameSync, type rmSync, type writeFileSync } from "node:fs";
import { executeManagedReconcile, safeManagedPath, type TransactionalFsWithCopy } from "../install.js";
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
  const foldedPaths = new Map<string, string>();
  for (const change of changes) {
    if (seen.has(change.path)) return { ok: false, message: `duplicate planned path: ${change.path}` };
    const folded = change.path.toLowerCase();
    const collision = foldedPaths.get(folded);
    if (collision) return { ok: false, message: `case-insensitive planned path collision: ${collision}, ${change.path}` };
    foldedPaths.set(folded, change.path);
    seen.set(change.path, change);
  }
  for (const [folded, path] of foldedPaths) {
    let parent = folded;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      const collision = foldedPaths.get(parent);
      if (collision) return { ok: false, message: `planned file and directory paths collide: ${collision}, ${path}` };
    }
  }
  const entries = [...seen.values()];
  const root = realpathSync(projectRoot);
  const targetFor = (path: string): string => safeManagedPath(root, path).target;
  let pending: PlannedFileChange[];
  try {
    pending = entries.filter((entry) => {
      const full = targetFor(entry.path);
      const current = fs_.existsSync(full) ? fs_.readTextFileSync(full) : undefined;
      if (current === entry.after) return false;
      if (current !== entry.before) throw new Error(`file changed since planning: ${entry.path}`);
      return true;
    });
    if (!pending.length) return { ok: true, alreadyConfigured: true, written: [] };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const writes = Object.fromEntries(pending.map((entry) => [entry.path, entry.after]));
  const expectedText = Object.fromEntries(pending.map((entry) => [entry.path, entry.before]));
  const transactionFs: TransactionalFsWithCopy = {
    existsSync: fs_.existsSync as typeof existsSync,
    readFileSync: ((path: string) => fs_.readTextFileSync(path)) as typeof readFileSync,
    mkdirSync: fs_.mkdirSync as typeof mkdirSync,
    writeFileSync: ((path: string, content: string | Uint8Array) => fs_.writeTextFileSync(path, String(content))) as typeof writeFileSync,
    renameSync: fs_.renameSync as typeof renameSync,
    rmSync: fs_.rmSync as typeof rmSync,
    readdirSync,
    copyFileSync,
  };
  try {
    executeManagedReconcile(root, writes, [], transactionFs, { expectedText });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: reason.includes("original files retained at") ? `recovery incomplete; ${reason}` : reason };
  }
  return { ok: true, alreadyConfigured: false, written: pending.map((e) => e.path) };
}
