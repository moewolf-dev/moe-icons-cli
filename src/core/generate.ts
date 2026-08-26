import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  executeGeneratedFilesDir,
  executeManagedReconcile,
  type TransactionalFsWithCopy,
} from "../project/install.js";
import { detectProject } from "../project/detect.js";
import { readMoeiconsConfig, type MoeiconsConfigFile } from "../project/config.js";
import { planGeneratedFiles } from "../generator/generate.js";
import { ensureClassMergeDependencies, planTailwindIntegration } from "../project/tailwind.js";
import { CliError, isCliError } from "../errors/index.js";
import { extractTarGz } from "../project/tar-gz.js";
import { artifactCachePath } from "./free-download.js";
import { resolveThemes } from "../generator/theme-resolve.js";
import type { CommandContext } from "./context.js";
import {
  parseInstallMetadata,
  serializeInstallMetadata,
  sha256Bytes,
  type InstallMetadata,
} from "../project/install-metadata.js";
import { withProjectLockSync } from "../project/project-lock.js";
import type { Target } from "../commands/parser.js";

export type GenerateResult =
  | {
      readonly ok: true;
      readonly files: readonly string[];
      readonly warnings?: readonly string[];
      readonly notes?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly errors?: readonly string[];
      readonly code?: string;
    };

function hasBitmapThemes(config: MoeiconsConfigFile): boolean {
  const resolved = resolveThemes(config);
  return resolved.ok && resolved.themes.some((theme) => theme.kind === "bitmap");
}

/** Vanilla/Assets generate from raw SVG; bitmap themes need variant binaries. */
function needsArchiveFiles(config: MoeiconsConfigFile): boolean {
  if (config.target === "vanilla" || config.target === "assets") return true;
  return hasBitmapThemes(config);
}

function archiveHasAssetsManifest(files: Readonly<Record<string, Uint8Array>>): boolean {
  return Object.keys(files).some((path) => /(?:^|\/)assets\/manifest\.json$/.test(path));
}

function missingArchiveMessage(config: MoeiconsConfigFile): string {
  if (config.target === "vanilla" || config.target === "assets") {
    return `${config.target} target requires an installed artifact; run \`moeicons install\` first`;
  }
  return "bitmap themes require a downloaded free artifact; run `moeicons install` or set MOEICONS_BITMAP_ARCHIVE";
}

function readInstallMetadata(
  projectRoot: string,
  readFileSync: (path: string, encoding: "utf8") => string,
  existsSync: (path: string) => boolean,
): { artifactVersion?: string; artifactSha256?: string; target?: Target } | undefined {
  const path = join(projectRoot, ".moeicons", "install-metadata.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      artifactVersion?: unknown;
      artifactSha256?: unknown;
      target?: unknown;
    };
    return {
      ...(typeof parsed.artifactVersion === "string"
        ? { artifactVersion: parsed.artifactVersion }
        : {}),
      ...(typeof parsed.artifactSha256 === "string"
        ? { artifactSha256: parsed.artifactSha256 }
        : {}),
      ...(typeof parsed.target === "string" &&
      ["react", "vue", "vanilla", "assets"].includes(parsed.target)
        ? { target: parsed.target as Target }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function readBinaryFile(
  fs_: Pick<TransactionalFsWithCopy, "readFileSync">,
  path: string,
): Uint8Array {
  const data = fs_.readFileSync(path) as Buffer | string;
  return typeof data === "string" ? Buffer.from(data, "utf8") : new Uint8Array(data);
}

/**
 * Load installed artifact bytes for generate. Prefers `.moeicons/artifact/<target>/`
 * when that subtree already contains the assets the generator needs (assets target).
 * Vanilla (and bitmap themes on react/vue) need the full cached archive so
 * `assets/` is available — the installed package subtree alone is not enough.
 */
export function loadArchiveFiles(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  fs_: Pick<TransactionalFsWithCopy, "readFileSync" | "existsSync" | "readdirSync">,
  injected?: Readonly<Record<string, Uint8Array>>,
):
  | { readonly ok: true; readonly files: Readonly<Record<string, Uint8Array>> }
  | { readonly ok: false; readonly reason: string } {
  if (injected) return { ok: true, files: injected };
  const fixtureTgz = env.MOEICONS_BITMAP_ARCHIVE;
  if (fixtureTgz && fs_.existsSync(fixtureTgz)) {
    const unpacked = extractTarGz(readBinaryFile(fs_, fixtureTgz), {
      maxEntries: 20_000,
      maxExpandedBytes: 64 * 1024 * 1024,
    });
    if (unpacked.errors.length > 0)
      return { ok: false, reason: unpacked.errors[0] ?? "invalid bitmap archive fixture" };
    return { ok: true, files: unpacked.files };
  }
  const meta = readInstallMetadata(projectRoot, fs_.readFileSync, fs_.existsSync);
  if (meta?.target) {
    const subtreeRoot = join(projectRoot, ".moeicons", "artifact", meta.target);
    if (fs_.existsSync(subtreeRoot)) {
      const files: Record<string, Uint8Array> = {};
      const walk = (dir: string, prefix: string): void => {
        let entries;
        try {
          entries = fs_.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const full = join(dir, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(full, rel);
            continue;
          }
          if (!entry.isFile()) continue;
          const data = readBinaryFile(fs_, full);
          files[`${meta.target}/${rel}`] = data;
        }
      };
      walk(subtreeRoot, "");
      // assets install lands the raw tree; reuse it. Package subtrees (react/vue/
      // vanilla) do not contain assets/manifest.json — fall through to the cache.
      if (Object.keys(files).length > 0 && (meta.target === "assets" || archiveHasAssetsManifest(files))) {
        return { ok: true, files };
      }
    }
  }
  const cacheDir = env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
  if (meta?.artifactVersion && meta.artifactSha256) {
    const cached = artifactCachePath(cacheDir, meta.artifactVersion, meta.artifactSha256);
    if (fs_.existsSync(cached)) {
      const unpacked = extractTarGz(readBinaryFile(fs_, cached), {
        maxEntries: 20_000,
        maxExpandedBytes: 64 * 1024 * 1024,
      });
      if (unpacked.errors.length > 0)
        return { ok: false, reason: unpacked.errors[0] ?? "invalid cached artifact" };
      return { ok: true, files: unpacked.files };
    }
  }
  return { ok: false, reason: "installed artifact not found" };
}

/**
 * B5: switching the configured target over an existing install is a destructive
 * migration (generated files are replaced and the install subtree changes).
 * Interactive TTY prompts for explicit confirmation; non-interactive/JSON mode
 * fails with VALIDATION_ERROR unless `--yes` was passed (the non-interactive
 * UI resolves `--yes` confirmations to true). Fresh projects with no install
 * metadata never prompt.
 */
async function confirmTargetSwitch(
  context: CommandContext,
  installedTarget: Target,
  configuredTarget: Target,
): Promise<boolean> {
  const message =
    `Existing install targets "${installedTarget}" but the config now targets "${configuredTarget}". ` +
    "Switching targets is a destructive migration that replaces generated files. Continue?";
  try {
    return (await context.ui.confirm(message, context.signal)) === true;
  } catch (error) {
    if (isCliError(error) && error.code === "NOT_TTY") {
      throw new CliError(
        "VALIDATION_ERROR",
        `target switch from "${installedTarget}" to "${configuredTarget}" is destructive and requires confirmation; pass --yes in non-interactive mode`,
      );
    }
    throw error;
  }
}

export async function runGenerateUseCase(
  context: CommandContext,
  fs_: TransactionalFsWithCopy,
  options: {
    readonly noTailwind?: boolean;
    readonly target?: Target;
    readonly archiveFiles?: Readonly<Record<string, Uint8Array>>;
    readonly reconcileInstalled?: boolean;
  } = {},
): Promise<GenerateResult> {
  const project = detectProject(context.cwd);
  if (!project) return { ok: false, reason: "no-project" };
  const loaded = readMoeiconsConfig(project.root);
  if (loaded.kind !== "ok") return { ok: false, reason: `config state: ${loaded.kind}` };

  const effectiveConfig = options.target
    ? { ...loaded.config, target: options.target }
    : loaded.config;
  const installedMeta = readInstallMetadata(project.root, fs_.readFileSync, fs_.existsSync);
  if (installedMeta?.target && installedMeta.target !== effectiveConfig.target) {
    const confirmed = await confirmTargetSwitch(
      context,
      installedMeta.target,
      effectiveConfig.target,
    );
    if (!confirmed)
      return {
        ok: false,
        reason: "cancelled",
        errors: [`target switch from "${installedMeta.target}" to "${effectiveConfig.target}" cancelled`],
      };
  }
  let archiveFiles: Readonly<Record<string, Uint8Array>> | undefined = options.archiveFiles;
  if (needsArchiveFiles(effectiveConfig) && archiveFiles === undefined) {
    const loadedArchive = loadArchiveFiles(project.root, context.env, fs_, undefined);
    if (!loadedArchive.ok) {
      return {
        ok: false,
        reason: "validation",
        errors: [missingArchiveMessage(effectiveConfig)],
      };
    }
    archiveFiles = loadedArchive.files;
  }

  const plan = planGeneratedFiles(
    effectiveConfig,
    effectiveConfig.outputDir,
    archiveFiles ? { archiveFiles } : {},
  );
  if (!plan.ok) return { ok: false, reason: "validation", errors: plan.errors };

  const notes: string[] = [];
  const sideFiles: { path: string; content: string }[] = [];

  try {
    const tw = planTailwindIntegration(project.root, loaded.config.outputDir, {
      noTailwind: options.noTailwind === true,
      target: effectiveConfig.target,
    });
    notes.push(...tw.notes);
    sideFiles.push(...tw.files);
  } catch (error) {
    if (isCliError(error) && error.code === "TAILWIND_VERSION_UNSUPPORTED") {
      return { ok: false, reason: error.message, code: error.code };
    }
    throw error;
  }

  const pkgPath = join(project.root, "package.json");
  if (fs_.existsSync(pkgPath)) {
    const pkgSource = fs_.readFileSync(pkgPath, "utf8");
    const target = effectiveConfig.target;
    const deps =
      target === "react" || target === "vue"
        ? ensureClassMergeDependencies(pkgSource)
        : {
            nextSource: pkgSource,
            changed: false,
            notes: [`skipped class merge dependencies for ${target} target`],
          };
    notes.push(...deps.notes);
    if (deps.changed) {
      sideFiles.push({ path: pkgPath, content: deps.nextSource });
    }
  }

  try {
    if (options.reconcileInstalled) {
      const metadataPath = join(project.root, ".moeicons", "install-metadata.json");
      if (!fs_.existsSync(metadataPath))
        return {
          ok: false,
          reason: "managed install metadata is missing; run repair or reinstall",
        };
      const metadata = parseInstallMetadata(fs_.readFileSync(metadataPath, "utf8"));
      if (!metadata || metadata.tier !== loaded.config.tier)
        return {
          ok: false,
          reason:
            "managed install metadata is invalid or does not match config tier; run repair or reinstall",
        };
      for (const [managedPath, expected] of Object.entries(metadata.managedFiles)) {
        const absolute = join(project.root, managedPath);
        if (
          !fs_.existsSync(absolute) ||
          sha256Bytes(fs_.readFileSync(absolute) as string | Uint8Array) !== expected
        ) {
          return { ok: false, reason: `managed file was modified or removed: ${managedPath}` };
        }
      }
      if (metadata.managedFiles[".moeicons/catalog.json"] !== metadata.catalogSha256)
        return {
          ok: false,
          reason: "managed catalog hash is inconsistent; run repair or reinstall",
        };

      const outputPrefix = loaded.config.outputDir.replace(/\\/g, "/").replace(/\/$/, "") + "/";
      const generated = Object.fromEntries(
        plan.files.map((file) => [file.path.replace(/\\/g, "/"), file.content]),
      );
      const nextManaged: Record<string, string> = {};
      for (const [managedPath, hash] of Object.entries(metadata.managedFiles))
        if (!managedPath.startsWith(outputPrefix)) nextManaged[managedPath] = hash;
      for (const [path, content] of Object.entries(generated))
        nextManaged[path] = sha256Bytes(content);
      const nextMetadata: InstallMetadata = { ...metadata, managedFiles: nextManaged };
      const writes: Record<string, string | Uint8Array> = { ...generated };
      for (const file of sideFiles) {
        const absolute = resolve(file.path);
        const rel = relative(project.root, absolute).replace(/\\/g, "/");
        if (!rel || rel.startsWith("../") || rel === "..")
          return { ok: false, reason: `side file escapes project: ${file.path}` };
        writes[rel] = file.content;
      }
      writes[".moeicons/install-metadata.json"] = serializeInstallMetadata(nextMetadata);
      const stale = Object.keys(metadata.managedFiles).filter(
        (path) => path.startsWith(outputPrefix) && !(path in generated),
      );
      withProjectLockSync(project.root, "reload", () =>
        executeManagedReconcile(project.root, writes, stale, fs_),
      );
      return {
        ok: true,
        files: plan.files.map((file) => file.path),
        ...(loaded.warnings.length > 0 || notes.length > 0
          ? { warnings: [...loaded.warnings, ...notes] }
          : {}),
      };
    }
    executeGeneratedFilesDir(plan.files, project.root, loaded.config.outputDir, fs_);
    for (const file of sideFiles) {
      fs_.writeFileSync(file.path, file.content);
    }
    return {
      ok: true,
      files: plan.files.map((file) => file.path),
      ...(loaded.warnings.length > 0 || notes.length > 0
        ? { warnings: [...loaded.warnings, ...notes] }
        : {}),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
