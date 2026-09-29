import { join, relative, resolve, dirname, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, readFileSync as realReadFileSync } from "node:fs";
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

/**
 * Atomically reconcile an explicit cross-directory managed set. `removePaths`
 * must come from trusted metadata; this function never scans or uses globs.
 */
export function executeManagedReconcile(
  projectRoot: string,
  writes: Readonly<Record<string, string | Uint8Array>>,
  removePaths: readonly string[],
  fs_: TransactionalFsWithCopy,
): void {
  const operationId = randomUUID();
  const stagingRoot = join(projectRoot, ".moeicons", `.reconcile-staging-${operationId}`);
  const backupRoot = join(projectRoot, ".moeicons", `.reconcile-backup-${operationId}`);
  const safe = (relative: string) => {
    const normalized = relative.replace(/\\/g, "/");
    if (!normalized || relative.includes("\\") || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(normalized)) throw new Error(`unsafe managed path: ${relative}`);
    const project = realpathSync(projectRoot);
    const target = resolve(project, normalized);
    if (!target.startsWith(`${project}${sep}`)) throw new Error(`managed path escapes project: ${relative}`);
    let ancestor = target;
    while (ancestor !== project && !existsOnDisk(ancestor)) ancestor = dirname(ancestor);
    for (let current = ancestor; current !== project; current = dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`managed path contains symbolic link: ${relative}`);
    }
    return { normalized, target };
  };
  const entries = Object.entries(writes).map(([relative, content]) => ({ ...safe(relative), content }));
  const removals = [...new Set(removePaths)].map(safe).filter((item) => !Object.hasOwn(writes, item.normalized));
  const allPaths = [...entries, ...removals].map((item) => item.normalized.toLowerCase()).sort();
  for (let i = 1; i < allPaths.length; i++) {
    const previous = allPaths[i - 1]!;
    const current = allPaths[i]!;
    if (previous === current) throw new Error(`duplicate managed path (case-insensitive): ${current}`);
    if (current.startsWith(`${previous}/`)) {
      throw new Error(`managed file and directory paths collide: ${previous}`);
    }
  }
  const backedUp: Array<{ target: string; backup: string }> = [];
  const installed: string[] = [];
  let preserveBackup = false;
  try {
    for (const entry of entries) {
      const staged = join(stagingRoot, entry.normalized);
      fs_.mkdirSync(join(staged, ".."), { recursive: true });
      fs_.writeFileSync(staged, entry.content);
    }
    for (const item of [...removals, ...entries]) {
      safe(item.normalized);
      if (!fs_.existsSync(item.target)) continue;
      const backup = join(backupRoot, item.normalized);
      fs_.mkdirSync(join(backup, ".."), { recursive: true });
      fs_.renameSync(item.target, backup);
      backedUp.push({ target: item.target, backup });
    }
    for (const entry of entries) {
      safe(entry.normalized);
      const staged = join(stagingRoot, entry.normalized);
      fs_.mkdirSync(join(entry.target, ".."), { recursive: true });
      fs_.renameSync(staged, entry.target);
      installed.push(entry.target);
    }
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const target of installed.reverse()) {
      if (fs_.existsSync(target)) {
        try { fs_.rmSync(target, { force: true }); } catch (recoveryError) { recoveryErrors.push(recoveryError); }
      }
    }
    for (const item of backedUp.reverse()) {
      if (fs_.existsSync(item.backup)) {
        try {
          fs_.mkdirSync(join(item.target, ".."), { recursive: true });
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
    if (fs_.existsSync(stagingRoot)) fs_.rmSync(stagingRoot, { recursive: true, force: true });
  }
  // The new state is committed. A cleanup failure must not trigger rollback
  // after any backup bytes have already been removed.
  if (fs_.existsSync(backupRoot)) fs_.rmSync(backupRoot, { recursive: true, force: true });
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
  const operationId = randomUUID();
  const stagingRoot = join(project, `.moeicons-install-staging-${operationId}`);
  const backupRoot = join(project, `.moeicons-install-backup-${operationId}`);
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
  const metadataPath = join(project, ".moeicons", "install-metadata.json");
  const prior = existsOnDisk(metadataPath)
    ? parseInstallMetadata(realReadFileSync(metadataPath, "utf8"), { allowLocalTest: true })
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

  const backups: { original: string; backup: string }[] = [];
  const installed: string[] = [];
  let preserveBackup = false;
  try {
    fs_.mkdirSync(project, { recursive: true });
    fs_.mkdirSync(stagingRoot, { recursive: false });
    for (const { item, rel } of validated) {
      const staged = join(stagingRoot, rel);
      fs_.mkdirSync(join(staged, ".."), { recursive: true });
      fs_.writeFileSync(staged, item.bytes ?? item.content ?? "");
    }

    // move staged files into place, backing up existing managed output
    for (const { rel, target } of staleOwned) {
      const backup = join(backupRoot, rel);
      fs_.mkdirSync(dirname(backup), { recursive: true });
      fs_.renameSync(target, backup);
      backups.push({ original: target, backup });
    }
    for (const { rel, target } of validated) {
      const staged = join(stagingRoot, rel);
      if (fs_.existsSync(target)) {
        const backup = join(backupRoot, rel);
        fs_.mkdirSync(dirname(backup), { recursive: true });
        fs_.renameSync(target, backup);
        backups.push({ original: target, backup });
      }
      fs_.mkdirSync(dirname(target), { recursive: true });
      fs_.renameSync(staged, target);
      installed.push(target);
    }
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const path of installed.reverse()) {
      if (fs_.existsSync(path)) {
        try { fs_.rmSync(path, { force: true }); } catch (recoveryError) { recoveryErrors.push(recoveryError); }
      }
    }
    // restore any backups made before the failure
    for (const b of backups.reverse()) {
      try {
        if (fs_.existsSync(b.backup)) fs_.renameSync(b.backup, b.original);
      } catch (recoveryError) {
        preserveBackup = true;
        recoveryErrors.push(recoveryError);
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        preserveBackup
          ? `install failed; original files retained at ${backupRoot}`
          : "install failed; original files were restored with recovery errors",
      );
    }
    throw error;
  } finally {
    if (fs_.existsSync(stagingRoot)) fs_.rmSync(stagingRoot, { recursive: true, force: true });
    if (!preserveBackup && fs_.existsSync(backupRoot)) fs_.rmSync(backupRoot, { recursive: true, force: true });
  }
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

    if (backedUp) {
      fs_.rmSync(backupRoot, { recursive: true, force: true });
    }
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

export interface DownloadLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly allowedHosts?: readonly string[];
  readonly userAgent?: string;
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
  readonly allowHttpLoopback?: boolean;
}

export type DownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly finalUrl: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Download an artifact. HTTPS only, optional host allowlist, bounded redirects,
 * timeout, byte limit. Abort and temporary-file cleanup are handled by the
 * caller via the injected fetch/signal.
 *
 * Redirect policy: unlike the API descriptor handshake (which uses
 * `redirect: "error"`), payload downloads intentionally follow a bounded number
 * of redirects because code/metadata archives are served from CDNs that 3xx to
 * a signed object host; the destination host is re-checked against the
 * allowlist on every hop.
 */
export async function downloadArtifact(
  url: string,
  limits: DownloadLimits,
  deps: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DownloadResult> {
  const parsed = new URL(url);
  const loopbackHttp = limits.allowHttpLoopback === true && parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1");
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    return { ok: false, code: "NON_HTTPS", message: "artifact URLs must use https" };
  }
  if (limits.allowedHosts && !limits.allowedHosts.includes(parsed.host)) {
    return { ok: false, code: "HOST_NOT_ALLOWED", message: `host ${parsed.host} not in allowlist` };
  }

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const abortHandler = () => controller.abort();
  deps.signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    let currentUrl = url;
    let redirects = 0;
    let response: Response | undefined;
    for (;;) {
      response = await fetchFn(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        ...(limits.userAgent ? { headers: { "user-agent": limits.userAgent } } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        redirects += 1;
        if (redirects > limits.maxRedirects) {
          return { ok: false, code: "TOO_MANY_REDIRECTS", message: `exceeded ${limits.maxRedirects} redirects` };
        }
        const location = response.headers.get("location");
        if (!location) {
          return { ok: false, code: "REDIRECT_NO_LOCATION", message: "redirect without location header" };
        }
        currentUrl = new URL(location, currentUrl).toString();
        const next = new URL(currentUrl);
        const nextLoopback = limits.allowHttpLoopback === true && next.protocol === "http:" && (next.hostname === "127.0.0.1" || next.hostname === "localhost" || next.hostname === "::1");
        if (next.protocol !== "https:" && !nextLoopback) {
          return { ok: false, code: "NON_HTTPS", message: "redirect to non-https url" };
        }
        if (limits.allowedHosts && !limits.allowedHosts.includes(next.host)) {
          return { ok: false, code: "HOST_NOT_ALLOWED", message: `redirect host ${next.host} not in allowlist` };
        }
        continue;
      }
      break;
    }

    if (!response || response.status >= 400) {
      return { ok: false, code: "HTTP_ERROR", message: `request failed with ${response.status ?? "unknown"}` };
    }

    const rawLength = response.headers.get("content-length");
    const contentLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
    if (contentLength !== undefined && contentLength > limits.maxBytes) {
      return { ok: false, code: "TOO_LARGE", message: `content-length ${contentLength} exceeds limit` };
    }

    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value as Uint8Array;
        downloadedBytes += value.byteLength;
        if (downloadedBytes > limits.maxBytes) {
          await reader.cancel();
          return { ok: false, code: "TOO_LARGE", message: `body exceeds byte limit ${limits.maxBytes}` };
        }
        chunks.push(value);
        limits.onProgress?.({ downloadedBytes, ...(contentLength !== undefined ? { totalBytes: contentLength } : {}) });
      }
    } else {
      const buffer = await response.arrayBuffer();
      downloadedBytes = buffer.byteLength;
      if (downloadedBytes > limits.maxBytes) return { ok: false, code: "TOO_LARGE", message: `body exceeds byte limit ${limits.maxBytes}` };
      chunks.push(new Uint8Array(buffer));
      limits.onProgress?.({ downloadedBytes, ...(contentLength !== undefined ? { totalBytes: contentLength } : {}) });
    }
    const bytes = new Uint8Array(downloadedBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, bytes, finalUrl: currentUrl };
  } catch (error) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abortHandler);
  }
}

/** Verify a downloaded artifact against an expected SHA-256 (and optional signature). */
export function verifyArtifact(
  bytes: Uint8Array,
  expectedSha256: string,
): { ok: boolean; actual: string } {
  const actual = createHash("sha256").update(bytes).digest("hex");
  return { ok: actual.toLowerCase() === expectedSha256.toLowerCase(), actual };
}
