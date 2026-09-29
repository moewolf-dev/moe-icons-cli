import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const targetFor = (path: string): string => {
    if (!path || isAbsolute(path) || path.includes("\\") || /^[A-Za-z]:/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`unsafe planned path: ${path}`);
    }
    const target = resolve(root, path);
    if (relative(root, target).startsWith(`..${sep}`) || target === root) throw new Error(`unsafe planned path: ${path}`);
    for (let part = dirname(target); part !== root; part = dirname(part)) {
      try { if (lstatSync(part).isSymbolicLink()) throw new Error(`symlink in planned path: ${path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { if (lstatSync(target).isSymbolicLink()) throw new Error(`symlink target: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return target;
  };
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

  const operationId = randomUUID();
  const backupRoot = join(root, ".moeicons", `.doctor-backup-${operationId}`);
  const stagingRoot = join(root, ".moeicons", `.doctor-staging-${operationId}`);
  const backedUp: Array<{ target: string; backup: string }> = [];
  const installed: string[] = [];
  try {
    targetFor(".moeicons");
    for (const entry of pending) {
      const staged = join(stagingRoot, entry.path);
      fs_.mkdirSync(dirname(staged), { recursive: true });
      fs_.writeTextFileSync(staged, entry.after);
    }
    // Recheck before moving any original: a preview must never overwrite edits.
    for (const entry of pending) {
      const full = targetFor(entry.path);
      const current = fs_.existsSync(full) ? fs_.readTextFileSync(full) : undefined;
      if (current !== entry.before) throw new Error(`file changed since planning: ${entry.path}`);
    }
    for (const entry of pending) {
      const full = targetFor(entry.path);
      const current = fs_.existsSync(full) ? fs_.readTextFileSync(full) : undefined;
      if (current !== entry.before) throw new Error(`file changed since planning: ${entry.path}`);
      if (fs_.existsSync(full)) {
        const backup = join(backupRoot, entry.path);
        fs_.mkdirSync(dirname(backup), { recursive: true });
        fs_.renameSync(full, backup);
        backedUp.push({ target: full, backup });
      }
      fs_.mkdirSync(dirname(full), { recursive: true });
      fs_.renameSync(join(stagingRoot, entry.path), full);
      installed.push(full);
    }
  } catch (error) {
    let recoveryFailed = false;
    for (const target of installed.reverse()) {
      try { if (fs_.existsSync(target)) fs_.rmSync(target, { force: true }); }
      catch { recoveryFailed = true; }
    }
    for (const item of backedUp.reverse()) {
      if (fs_.existsSync(item.backup)) {
        try {
          fs_.mkdirSync(dirname(item.target), { recursive: true });
          fs_.renameSync(item.backup, item.target);
        } catch { recoveryFailed = true; }
      }
    }
    try { if (fs_.existsSync(stagingRoot)) fs_.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* retain for inspection */ }
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: recoveryFailed ? `${reason}; recovery incomplete, originals at ${backupRoot}` : reason };
  }
  try {
    if (fs_.existsSync(stagingRoot)) fs_.rmSync(stagingRoot, { recursive: true, force: true });
    if (fs_.existsSync(backupRoot)) fs_.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, message: `changes committed, backup cleanup failed at ${backupRoot}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, alreadyConfigured: false, written: pending.map((e) => e.path) };
}
