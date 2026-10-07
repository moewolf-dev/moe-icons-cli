import { join, relative, resolve, dirname, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, readFileSync as realReadFileSync, readdirSync as realReaddirSync, copyFileSync as realCopyFileSync } from "node:fs";
import { parseInstallMetadata, sha256Bytes } from "./install-metadata.js";
import { strToU8, zipSync, unzipSync } from "fflate";
import type {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
  copyFileSync,
} from "node:fs";

/**
 * Transactional install: stage sibling, verify all files, backup existing
 * managed output, rename atomically, update config last, restore on failure.
 * Never touches the project tree until every file is verified in staging.
 */

export interface InstallPlanItem {
  readonly kind: "mkdir" | "write" | "remove" | "config";
  readonly path: string;
  /** Relative path inside the install root, used to stage nested files safely. */
  readonly rel?: string;
  readonly content?: string;
  readonly bytes?: Uint8Array;
}

export interface InstallPlan {
  readonly root?: string;
  readonly items: readonly InstallPlanItem[];
}

export interface TransactionalFs {
  readonly mkdirSync: typeof mkdirSync;
  readonly writeFileSync: typeof writeFileSync;
  readonly existsSync: typeof existsSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
}

export interface TransactionalFsWithCopy extends TransactionalFs {
  readonly readFileSync: typeof readFileSync;
  readonly readdirSync: typeof readdirSync;
  readonly copyFileSync: typeof copyFileSync;
}

/** Shared path boundary for install/update and doctor/init writes. */
export function safeManagedPath(projectRoot: string, relative: string): { normalized: string; target: string } {
  const normalized = relative.replace(/\\/g, "/");
  if (!normalized || relative.includes("\\") || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(normalized)) throw new Error(`unsafe managed path: ${relative}`);
  if ([".git", "node_modules"].includes(normalized.split("/")[0]!.toLowerCase())) throw new Error(`managed path uses a protected directory: ${relative}`);
  if (lstatSync(projectRoot).isSymbolicLink()) throw new Error(`project root contains symbolic link: ${projectRoot}`);
  const project = realpathSync(projectRoot);
  const target = resolve(project, normalized);
  if (!target.startsWith(`${project}${sep}`)) throw new Error(`managed path escapes project: ${relative}`);
  let ancestor = target;
  while (ancestor !== project && !existsOnDisk(ancestor)) ancestor = dirname(ancestor);
  for (let current = ancestor; current !== project; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`managed path contains symbolic link: ${relative}`);
  }
  return { normalized, target };
}

/**
 * Atomically reconcile an explicit cross-directory managed set. `removePaths`
 * must come from trusted metadata; this function never scans or uses globs.
 */
export function executeManagedReconcile(
  projectRoot: string,
  writes: Readonly<Record<string, string | Uint8Array>>,
  removePaths: readonly string[],
  fs_: TransactionalFsWithCopy,
  options: {
    readonly expectedText?: Readonly<Record<string, string | undefined>>;
    readonly expectedSha256?: Readonly<Record<string, string | undefined>>;
  } = {},
): void {
  // A previous process may have terminated between two renames. Restore only
  // journal-owned bytes before accepting another plan; callers must replan.
  if (recoverManagedReconcile(projectRoot, fs_) > 0) {
    throw new Error("interrupted transaction recovered; rerun the command to create a fresh plan");
  }
  const operationId = randomUUID();
  const safe = (relative: string) => safeManagedPath(projectRoot, relative);
  // Validate transaction paths too: .moeicons may be a symlink even when
  // every application entry is safe.
  const stagingRelative = `.moeicons/.reconcile-staging-${operationId}`;
  const backupRelative = `.moeicons/.reconcile-backup-${operationId}`;
  const stagingRoot = safe(stagingRelative).target;
  const backupRoot = safe(backupRelative).target;
  const checkExpected = (relative: string, target: string) => {
    if (Object.hasOwn(options.expectedSha256 ?? {}, relative)) {
      const expected = options.expectedSha256?.[relative];
      const current = fs_.existsSync(target) ? sha256Bytes(fs_.readFileSync(target)) : undefined;
      if (current !== expected) throw new Error(`file changed since planning: ${relative}`);
    }
    if (!Object.hasOwn(options.expectedText ?? {}, relative)) return;
    const expected = options.expectedText?.[relative];
    const current = fs_.existsSync(target) ? fs_.readFileSync(target, "utf8") : undefined;
    if (current !== expected) throw new Error(`file changed since planning: ${relative}`);
  };
  const entries = Object.entries(writes).map(([relative, content]) => ({ ...safe(relative), content }));
  const removals = [...new Set(removePaths)].map(safe).filter((item) => !Object.hasOwn(writes, item.normalized));
  for (const item of [...entries, ...removals]) {
    if (item.normalized.toLowerCase().startsWith(".moeicons/.reconcile-")) throw new Error(`managed path overlaps transaction control: ${item.normalized}`);
  }
  const allPaths = [...entries, ...removals].map((item) => item.normalized.toLowerCase()).sort();
  for (const entry of entries) checkExpected(entry.normalized, entry.target);
  for (const removal of removals) checkExpected(removal.normalized, removal.target);
  const pathSet = new Set(allPaths);
  for (const path of allPaths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (pathSet.has(parent)) throw new Error(`managed file and directory paths collide: ${parent}`);
    }
  }
  for (let i = 1; i < allPaths.length; i++) {
    const previous = allPaths[i - 1]!;
    const current = allPaths[i]!;
    if (previous === current) throw new Error(`duplicate managed path (case-insensitive): ${current}`);
    if (current.startsWith(`${previous}/`)) {
      throw new Error(`managed file and directory paths collide: ${previous}`);
    }
  }
  const backedUp: Array<{ target: string; backup: string; relative: string }> = [];
  const installed: Array<{ target: string; hash: string; relative: string }> = [];
  let preserveBackup = false;
  const journal = {
    version: 1, operationId, committed: false,
    entries: [...removals, ...entries].map((item) => ({
      path: item.normalized,
      before: fs_.existsSync(item.target) ? sha256Bytes(fs_.readFileSync(item.target)) : null,
      after: Object.hasOwn(writes, item.normalized) ? sha256Bytes(writes[item.normalized]!) : null,
    })),
  };
  const journalPath = join(backupRoot, "recovery.json");
  const plannedHashes = new Map(journal.entries.map((entry) => [entry.path, entry.before]));
  try {
    safe(".moeicons");
    fs_.mkdirSync(join(projectRoot, ".moeicons"), { recursive: true });
    safe(stagingRelative);
    fs_.mkdirSync(stagingRoot, { recursive: false });
    safe(backupRelative);
    fs_.mkdirSync(backupRoot, { recursive: false });
    for (const entry of entries) {
      safe(stagingRelative);
      const staged = join(stagingRoot, entry.normalized);
      fs_.mkdirSync(join(staged, ".."), { recursive: true });
      safe(`${stagingRelative}/${entry.normalized}`);
      fs_.writeFileSync(staged, entry.content);
    }
    // Persist the entire intent before the first destructive rename. Recovery
    // infers completed renames from hashes, so no per-rename journal gap exists.
    fs_.writeFileSync(journalPath, JSON.stringify(journal));
    for (const item of [...removals, ...entries]) {
      safe(item.normalized);
      checkExpected(item.normalized, item.target);
      const currentHash = fs_.existsSync(item.target) ? sha256Bytes(fs_.readFileSync(item.target)) : null;
      if (currentHash !== plannedHashes.get(item.normalized)) throw new Error(`file changed since planning: ${item.normalized}`);
      if (!fs_.existsSync(item.target)) continue;
      const backup = join(backupRoot, "files", item.normalized);
      safe(backupRelative);
      fs_.mkdirSync(join(backup, ".."), { recursive: true });
      fs_.renameSync(item.target, backup);
      backedUp.push({ target: item.target, backup, relative: item.normalized });
    }
    for (const entry of entries) {
      safe(entry.normalized);
      const staged = join(stagingRoot, entry.normalized);
      // Each target was moved to backup above. A newly appearing target is a
      // concurrent user write; never replace it with staged bytes.
      if (fs_.existsSync(entry.target)) throw new Error(`file changed since planning: ${entry.normalized}`);
      fs_.mkdirSync(join(entry.target, ".."), { recursive: true });
      safe(entry.normalized);
      fs_.renameSync(staged, entry.target);
      installed.push({ target: entry.target, hash: sha256Bytes(entry.content), relative: entry.normalized });
    }
    journal.committed = true;
    safe(backupRelative);
    fs_.writeFileSync(join(backupRoot, "committed"), operationId);
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const { target, hash, relative } of installed.reverse()) {
      if (existsOnDisk(target)) {
        try {
          safe(relative);
          if (lstatSync(target).isSymbolicLink() || sha256Bytes(realReadFileSync(target)) !== hash) {
            preserveBackup = true;
            recoveryErrors.push(new Error(`concurrent file retained at ${target}`));
            continue;
          }
          fs_.rmSync(target, { force: true });
        } catch (recoveryError) { recoveryErrors.push(recoveryError); }
      }
    }
    for (const item of backedUp.reverse()) {
      if (fs_.existsSync(item.backup)) {
        try {
          safe(item.relative);
          safe(`${backupRelative}/files/${item.relative}`);
          if (fs_.existsSync(item.target)) {
            preserveBackup = true;
            recoveryErrors.push(new Error(`concurrent file retained at ${item.target}`));
            continue;
          }
          fs_.mkdirSync(join(item.target, ".."), { recursive: true });
          safe(item.relative);
          fs_.renameSync(item.backup, item.target);
        } catch (recoveryError) {
          preserveBackup = true;
          recoveryErrors.push(recoveryError);
        }
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        preserveBackup
          ? `reconcile failed; original files retained at ${backupRoot}`
          : "reconcile failed; original files were restored with recovery errors",
      );
    }
    throw error;
  } finally {
    if (fs_.existsSync(stagingRoot)) { safe(stagingRelative); fs_.rmSync(stagingRoot, { recursive: true, force: true }); }
  }
  // The new state is committed. A cleanup failure must not trigger rollback
  // after any backup bytes have already been removed.
  if (fs_.existsSync(backupRoot)) {
    try { safe(backupRelative); fs_.rmSync(backupRoot, { recursive: true, force: true }); }
    catch (error) {
      throw new Error(`changes committed, backup cleanup failed at ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Recover an interrupted process while preserving any independently edited file.
 * Must run under the same project lock as reconcile. Invalid journals fail closed.
 * This covers process termination, not power loss or a hostile filesystem.
 */
export function recoverManagedReconcile(projectRoot: string, fs_: TransactionalFsWithCopy): number {
  const control = safeManagedPath(projectRoot, ".moeicons").target;
  if (!fs_.existsSync(control)) return 0;
  let recovered = 0;
  for (const name of fs_.readdirSync(control)) {
    if (!/^\.reconcile-backup-[0-9a-f-]{36}$/.test(name)) continue;
    const backupRoot = safeManagedPath(projectRoot, `.moeicons/${name}`).target;
    const journalPath = safeManagedPath(projectRoot, `.moeicons/${name}/recovery.json`).target;
    if (!fs_.existsSync(journalPath)) continue; // staging never reached mutation
    const journal = JSON.parse(fs_.readFileSync(journalPath, "utf8")) as {
      version: number; operationId: string; entries: Array<{ path: string; before: string | null; after: string | null }>;
    };
    const hashOrNull = (value: unknown) => value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
    if (journal.version !== 1 || name !== `.reconcile-backup-${journal.operationId}` || !Array.isArray(journal.entries) || journal.entries.some((entry) => !entry || typeof entry.path !== "string" || !hashOrNull(entry.before) || !hashOrNull(entry.after))) {
      throw new Error(`invalid recovery journal; originals retained at ${backupRoot}`);
    }
    if (journal.entries.some((entry) => entry.path.toLowerCase().startsWith(".moeicons/.reconcile-")) || new Set(journal.entries.map((entry) => entry.path.toLowerCase())).size !== journal.entries.length) throw new Error(`unsafe recovery journal at ${backupRoot}`);
    const entries = journal.entries.map((entry) => ({ ...entry, target: safeManagedPath(projectRoot, entry.path).target, backup: safeManagedPath(projectRoot, `.moeicons/${name}/files/${entry.path}`).target }));
    const committed = safeManagedPath(projectRoot, `.moeicons/${name}/committed`).target;
    if (fs_.existsSync(committed)) {
      if (fs_.readFileSync(committed, "utf8") !== journal.operationId) throw new Error(`invalid commit marker at ${backupRoot}`);
    } else {
      // Validate the complete recovery before deleting or restoring any file.
      for (const entry of entries) {
        const current = fs_.existsSync(entry.target) ? sha256Bytes(fs_.readFileSync(entry.target)) : null;
        const backup = fs_.existsSync(entry.backup) ? sha256Bytes(fs_.readFileSync(entry.backup)) : null;
        if ((backup !== null && backup !== entry.before) || (current !== null && current !== entry.after && current !== entry.before) || (entry.before !== null && backup === null && current !== entry.before)) {
          throw new Error(`recovery conflict at ${entry.path}; originals retained at ${backupRoot}`);
        }
      }
      for (const entry of entries.reverse()) {
        safeManagedPath(projectRoot, entry.path);
        if (fs_.existsSync(entry.backup)) {
          if (fs_.existsSync(entry.target)) fs_.rmSync(entry.target, { force: true });
          fs_.mkdirSync(dirname(entry.target), { recursive: true });
          safeManagedPath(projectRoot, entry.path);
          fs_.renameSync(entry.backup, entry.target);
        } else if (entry.before === null && fs_.existsSync(entry.target)) {
          fs_.rmSync(entry.target, { force: true });
        }
      }
    }
    const staging = safeManagedPath(projectRoot, `.moeicons/.reconcile-staging-${journal.operationId}`).target;
    if (fs_.existsSync(staging)) fs_.rmSync(staging, { recursive: true, force: true });
    fs_.rmSync(backupRoot, { recursive: true, force: true });
    recovered++;
  }
  return recovered;
}


/** Check the path before any staging directory or backup is touched. */
function safeOutputRoot(projectRoot: string, outputDir: string): string {
  const segments = outputDir.replace(/\\/g, "/").split("/");
  if (!outputDir || isAbsolute(outputDir) || /^[A-Za-z]:/.test(outputDir) ||
      segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe outputDir: ${outputDir}`);
  }
  if ([".git", ".moeicons", "node_modules"].includes(segments[0] ?? "")) {
    throw new Error(`outputDir cannot use a project control directory: ${outputDir}`);
  }
  const project = realpathSync(projectRoot);
  const output = resolve(project, outputDir);
  if (!output.startsWith(`${project}${sep}`)) throw new Error(`outputDir escapes project: ${outputDir}`);
  let ancestor = output;
  while (ancestor !== project && !existsOnDisk(ancestor)) ancestor = dirname(ancestor);
  for (let current = ancestor; current !== project; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`outputDir contains a symbolic link: ${outputDir}`);
  }
  if (ancestor !== project && !realpathSync(ancestor).startsWith(`${project}${sep}`)) {
    throw new Error(`outputDir resolves outside project: ${outputDir}`);
  }
  return output;
}

function existsOnDisk(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Pure list of install operations with expected checksums. */
export function createInstallPlan(
  targetRoot: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): InstallPlan {
  const items: InstallPlanItem[] = [];
  const sorted = Object.keys(files).sort((a, b) => a.localeCompare(b));
  const seen = new Set<string>();
  for (const rel of sorted) {
    const normalized = rel.replace(/\\/g, "/");
    if (!normalized || rel.includes("\\") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) ||
        normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`unsafe install path: ${rel}`);
    }
    const folded = normalized.toLowerCase();
    if (seen.has(folded)) throw new Error(`duplicate install path: ${rel}`);
    seen.add(folded);
    const content = files[rel];
    if (content !== undefined) {
      items.push(
        typeof content === "string"
          ? { kind: "write", path: join(targetRoot, rel), rel, content }
          : { kind: "write", path: join(targetRoot, rel), rel, bytes: content },
      );
    }
  }
  return { root: targetRoot, items };
}

/** Create a deterministic ZIP for delivery (fixed mtime). */
export function createArtifactZip(files: Readonly<Record<string, string>>): Uint8Array {
  const sorted = Object.keys(files).sort((a, b) => a.localeCompare(b));
  const dict: Record<string, Uint8Array> = {};
  for (const rel of sorted) {
    dict[rel] = strToU8(files[rel] ?? "");
  }
  return zipSync(dict, { level: 9, mtime: new Date("2020-01-01T00:00:00.000Z") });
}

/** Unzip an artifact, rejecting unsafe paths. */
export function extractArtifact(
  zipBytes: Uint8Array,
  limits: { maxEntries: number; maxExpandedBytes: number },
): { files: Record<string, string>; errors: string[] } {
  const files: Record<string, string> = {};
  const errors: string[] = [];
  let entries = 0;
  let expanded = 0;

  const dict = unzipSync(zipBytes);
  for (const [rel, bytes] of Object.entries(dict)) {
    entries += 1;
    if (entries > limits.maxEntries) {
      errors.push(`too many entries (> ${limits.maxEntries})`);
      break;
    }
    const cleaned = rel.replace(/\\/g, "/");
    if (cleaned.startsWith("/") || cleaned.split("/").includes("..")) {
      errors.push(`unsafe path "${rel}"`);
      continue;
    }
    expanded += bytes.byteLength;
    if (expanded > limits.maxExpandedBytes) {
      errors.push(`expanded size exceeds limit`);
      break;
    }
    files[cleaned] = new TextDecoder().decode(bytes);
  }
  return { files, errors };
}

/** SHA-256 hex of a string. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Execute an install plan against a filesystem with a staging dir, verifying
 * checksums before any rename. Restores the original tree on failure.
 */
export function executeInstallPlan(
  plan: InstallPlan,
  fs_: TransactionalFs,
): void {
  const writes = plan.items.filter((i) => i.kind === "write");

  const firstWrite = writes[0];
  if (!firstWrite) return;
  const requestedRoot = resolve(plan.root ?? dirname(resolve(firstWrite.path)));
  let existingAncestor = requestedRoot;
  while (!existsOnDisk(existingAncestor)) existingAncestor = dirname(existingAncestor);
  if (lstatSync(existingAncestor).isSymbolicLink()) throw new Error(`install root contains symbolic link: ${requestedRoot}`);
  const project = resolve(realpathSync(existingAncestor), relative(existingAncestor, requestedRoot));
  const validated = writes.map((item) => {
    const rel = item.rel;
    if (!rel || rel.includes("\\") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) ||
        rel.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`unsafe install path: ${rel ?? item.path}`);
    }
    const target = resolve(project, rel);
    if (relative(resolve(plan.root ?? project), resolve(item.path)).replace(/\\/g, "/") !== rel ||
        !target.startsWith(`${project}${sep}`)) {
      throw new Error(`install path escapes project: ${item.path}`);
    }
    let current = target;
    while (current !== project) {
      if (existsOnDisk(current) && lstatSync(current).isSymbolicLink()) {
        throw new Error(`install path contains symbolic link: ${item.path}`);
      }
      current = dirname(current);
    }
    return { item, rel, target };
  });
  const folded = validated.map((item) => item.rel.toLowerCase());
  if (new Set(folded).size !== folded.length) throw new Error("duplicate install paths");
  const reconcileFs = { ...fs_, readFileSync: realReadFileSync, readdirSync: realReaddirSync, copyFileSync: realCopyFileSync };
  fs_.mkdirSync(project, { recursive: true });
  if (recoverManagedReconcile(project, reconcileFs) > 0) throw new Error("interrupted transaction recovered; rerun the command to create a fresh plan");
  const metadataPath = join(project, ".moeicons", "install-metadata.json");
  const priorMetadataText = existsOnDisk(metadataPath) ? realReadFileSync(metadataPath, "utf8") : undefined;
  const prior = priorMetadataText !== undefined
    ? parseInstallMetadata(priorMetadataText, { allowLocalTest: true })
    : undefined;
  if (existsOnDisk(metadataPath) && !prior) throw new Error("existing install metadata is invalid; refusing to overwrite project files");
  if (prior) {
    for (const [rel, hash] of Object.entries(prior.managedFiles)) {
      const owned = resolve(project, rel);
      if (!owned.startsWith(`${project}${sep}`) || !existsOnDisk(owned) ||
          lstatSync(owned).isSymbolicLink() || sha256Bytes(realReadFileSync(owned)) !== hash) {
        throw new Error(`managed file was modified or removed: ${rel}`);
      }
    }
  }
  for (const { rel, target } of validated) {
    if (!existsOnDisk(target)) continue;
    if (rel === ".moeicons/install-metadata.json" && prior) continue;
    if (!prior || prior.managedFiles[rel] === undefined) {
      throw new Error(`install path collides with an unowned user file: ${rel}`);
    }
  }
  const nextPaths = new Set(validated.map((entry) => entry.rel));
  const staleOwned = prior
    ? Object.keys(prior.managedFiles).filter((rel) => !nextPaths.has(rel)).map((rel) => ({ rel, target: resolve(project, rel) }))
    : [];

  const expectedSha256 = Object.fromEntries([...validated, ...staleOwned].map(({ rel, target }) => [rel,
    rel === ".moeicons/install-metadata.json"
      ? (priorMetadataText === undefined ? undefined : sha256Bytes(priorMetadataText))
      : prior?.managedFiles[rel] ?? (existsOnDisk(target) ? sha256Bytes(realReadFileSync(target)) : undefined),
  ]));
  executeManagedReconcile(project,
    Object.fromEntries(validated.map(({ item, rel }) => [rel, item.bytes ?? item.content ?? ""])),
    staleOwned.map(({ rel }) => rel), reconcileFs, { expectedSha256 });
}

/**
 * Transactionally replace only generated files. Existing files outside this
 * explicit list are left untouched, which makes the output directory safe to
 * share with user-owned files.
 */
export function executeGeneratedFiles(
  files: readonly { path: string; content: string }[],
  projectRoot: string,
  outputDir: string,
  fs_: TransactionalFs,
): void {
  const outputRoot = safeOutputRoot(projectRoot, outputDir);
  const operationId = randomUUID();
  const stagingRoot = `${outputRoot}.staging-${operationId}`;

  const entries = files.map((file) => {
    const target = resolve(realpathSync(projectRoot), file.path);
    const relative = target.slice(outputRoot.length).replace(/^[/\\]/, "");
    if (target !== outputRoot && !target.startsWith(`${outputRoot}/`) && !target.startsWith(`${outputRoot}\\`)) {
      throw new Error(`generated path escapes output directory: ${file.path}`);
    }
    return { target, staged: join(stagingRoot, relative), content: file.content };
  });
  fs_.mkdirSync(stagingRoot, { recursive: true });
  const backups: { original: string; backup: string }[] = [];
  const installed: string[] = [];
  try {
    for (const entry of entries) {
      fs_.mkdirSync(join(entry.staged, ".."), { recursive: true });
      fs_.writeFileSync(entry.staged, entry.content);
    }
    for (const entry of entries) {
      if (fs_.existsSync(entry.target)) {
        const backup = `${entry.target}.bak-${operationId}`;
        fs_.renameSync(entry.target, backup);
        backups.push({ original: entry.target, backup });
      }
      fs_.mkdirSync(join(entry.target, ".."), { recursive: true });
      fs_.renameSync(entry.staged, entry.target);
      installed.push(entry.target);
    }
  } catch (error) {
    for (const path of installed.reverse()) if (fs_.existsSync(path)) fs_.rmSync(path, { force: true });
    for (const backup of backups.reverse()) {
      try {
        if (fs_.existsSync(backup.backup)) fs_.renameSync(backup.backup, backup.original);
      } catch {
        // Preserve the backup when the filesystem cannot restore it.
      }
    }
    throw error;
  } finally {
    if (fs_.existsSync(stagingRoot)) fs_.rmSync(stagingRoot, { recursive: true, force: true });
  }
  for (const backup of backups) {
    if (fs_.existsSync(backup.backup)) fs_.rmSync(backup.backup, { force: true });
  }
}

/**
 * Directory-level transactional generate: writes all CLI-managed files into a
 * sibling staging directory, renames the current output directory to a backup,
 * renames staging to output, then merges user-owned files (files not in the
 * CLI-managed set) back from the backup. Restores the backup on any failure so
 * the output directory is never left in a partial state.
 *
 * The set of CLI-managed paths is determined by the `files` argument. Any file
 * that already exists in outputDir is considered user-owned and is preserved.
 * This compatibility writer has no ownership metadata, so it refuses to
 * replace an existing path. Production generation uses managed reconciliation.
 */
export function executeGeneratedFilesDir(
  files: readonly { path: string; content: string | Uint8Array }[],
  projectRoot: string,
  outputDir: string,
  fs_: TransactionalFsWithCopy,
): void {
  const outputRoot = safeOutputRoot(projectRoot, outputDir);
  const operationId = randomUUID();
  const stagingRoot = `${outputRoot}.staging-${operationId}`;
  const backupRoot = `${outputRoot}.bak-${operationId}`;

  // Validate all paths up front.
  const managedRelPaths = new Set<string>();
  const entries = files.map((file) => {
    const target = resolve(realpathSync(projectRoot), file.path);
    if (target !== outputRoot && !target.startsWith(`${outputRoot}/`) && !target.startsWith(`${outputRoot}\\`)) {
      throw new Error(`generated path escapes output directory: ${file.path}`);
    }
    const rel = target.slice(outputRoot.length).replace(/^[/\\]/, "");
    if (!rel || managedRelPaths.has(rel.toLowerCase())) throw new Error(`duplicate generated path: ${file.path}`);
    managedRelPaths.add(rel.toLowerCase());
    return { staged: join(stagingRoot, rel), content: file.content };
  });

  // Copy user files while the old tree is still live. A failed copy must never
  // make the generated tree visible or delete the only copy of a user file.
  const userFiles = fs_.existsSync(outputRoot)
    ? collectUserFiles(outputRoot, outputRoot, managedRelPaths, fs_)
    : [];
  let backedUp = false;
  let installed = false;

  try {
    fs_.mkdirSync(stagingRoot, { recursive: true });
    // 1. Write all CLI-managed files into staging.
    for (const entry of entries) {
      fs_.mkdirSync(join(entry.staged, ".."), { recursive: true });
      fs_.writeFileSync(entry.staged, entry.content);
    }

    for (const { rel, src } of userFiles) {
      const dest = join(stagingRoot, rel);
      fs_.mkdirSync(dirname(dest), { recursive: true });
      fs_.copyFileSync(src, dest);
    }

    if (fs_.existsSync(outputRoot)) {
      fs_.renameSync(outputRoot, backupRoot);
      backedUp = true;
    }
    fs_.renameSync(stagingRoot, outputRoot);
    installed = true;
  } catch (error) {
    if (backedUp && fs_.existsSync(backupRoot)) {
      try {
        if (installed && fs_.existsSync(outputRoot)) fs_.rmSync(outputRoot, { recursive: true, force: true });
        fs_.renameSync(backupRoot, outputRoot);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `generation failed; original files retained at ${backupRoot}`);
      }
    }
    if (fs_.existsSync(stagingRoot)) {
      fs_.rmSync(stagingRoot, { recursive: true, force: true });
    }
    throw error;
  }
  // The replacement is live. A partially removed backup cannot be restored.
  if (backedUp) {
    try { fs_.rmSync(backupRoot, { recursive: true, force: true }); }
    catch (error) { throw new Error(`changes committed, backup cleanup failed at ${backupRoot}: ${String(error)}`); }
  }
}

/** Recursively collect files in `dir` that are NOT in `managedRelPaths`. */
function collectUserFiles(
  dir: string,
  rootDir: string,
  managedRelPaths: ReadonlySet<string>,
  fs_: TransactionalFsWithCopy,
): { rel: string; src: string }[] {
  const result: { rel: string; src: string }[] = [];
  const entries = fs_.readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const rel = full.slice(rootDir.length).replace(/^[/\\]/, "");
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link in generated directory: ${full}`);
    const isDir = stat.isDirectory();
    if (isDir) {
      result.push(...collectUserFiles(full, rootDir, managedRelPaths, fs_));
    } else if (managedRelPaths.has(rel.toLowerCase())) {
      throw new Error(`generated path collides with an unowned user file: ${rel}`);
    } else {
      result.push({ rel, src: full });
    }
  }
  return result;
}

/** Atomically create a new file without replacing an existing user file. */
export function createFileIfAbsent(target: string, content: string, fs_: TransactionalFs): boolean {
  if (fs_.existsSync(target)) return false;
  const staging = `${target}.staging-${randomUUID()}`;
  fs_.mkdirSync(join(target, ".."), { recursive: true });
  try {
    fs_.writeFileSync(staging, content, { flag: "wx" });
    fs_.renameSync(staging, target);
    return true;
  } finally {
    if (fs_.existsSync(staging)) fs_.rmSync(staging, { force: true });
  }
}

export { downloadArtifact, verifyArtifact } from "./download.js";
export type { DownloadLimits, DownloadResult } from "./download.js";
