import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  executeManagedReconcile,
  safeManagedPath,
  type TransactionalFsWithCopy,
} from "../project/install.js";
import { detectProject } from "../project/detect.js";
import {
  readMoeiconsConfig,
  loadConfigDocument,
  type MoeiconsConfigFile,
} from "../project/config.js";
import { catalog as defaultCatalog, parseCatalog, type IconCatalog } from "../catalog/catalog.js";
import { toProxyName } from "./icon-names.js";
import { planGeneratedFiles } from "../generator/generate.js";
import { ensureClassMergeDependencies, planTailwindIntegration } from "../project/tailwind.js";
import { isCliError } from "../errors/index.js";
import {
  extractTarGzAsync,
  ICON_ARCHIVE_MAX_ENTRIES,
  ICON_ARCHIVE_MAX_EXPANDED_BYTES,
} from "../project/tar-gz.js";
import { artifactCachePath } from "./free-download.js";
import { resolveThemes } from "../generator/theme-resolve.js";
import type { ResourceVariant } from "./resource-variant.js";
import { loadPinnedBitmapShardAssets } from "./bitmap-shard-resolver.js";
import type { CommandContext } from "./context.js";
import {
  parseInstallMetadata,
  serializeInstallMetadata,
  sha256Bytes,
  type InstallMetadata,
  type InstallMetadataParseOptions,
} from "../project/install-metadata.js";
import { withProjectLockSync } from "../project/project-lock.js";
import type { Target } from "../commands/parser.js";
import { allowLocalTestFromEnv } from "./local-test-env.js";
import { resolveIconTheme, themeHasIcon } from "./icon-selection.js";

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

function hasBitmapThemes(config: MoeiconsConfigFile, sourceCatalog?: IconCatalog): boolean {
  const resolved = resolveThemes(config, sourceCatalog);
  return resolved.ok && resolved.themes.some((theme) => theme.kind === "bitmap");
}

/**
 * B7A/B5: prefer the catalog written by install / pro-install / library update
 * (`.moeicons/catalog.json`) over the bundled catalog. The installed catalog
 * carries the resourceVersion's real style groups (including migrated
 * `moe-colored` free+pro and bitmap variants), so generate/reconcile must not
 * validate against a stale bundled allowlist. Missing/corrupt catalogs fall
 * back to the bundled catalog; the reconcile path still hash-verifies it.
 */
export type InstalledCatalogState =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly catalog: IconCatalog }
  | { readonly status: "invalid"; readonly message: string };

/**
 * B7A/B5/DEV-20-02: load the catalog written by install / pro-install / library
 * update and verify it against the install metadata hash. A missing catalog
 * falls back to the bundled contract; a corrupt or drifting one must surface a
 * repair/reinstall error instead of silently switching entitlement semantics.
 */
export function loadInstalledCatalogState(
  projectRoot: string,
  fs_: Pick<TransactionalFsWithCopy, "readFileSync" | "existsSync">,
  opts: InstallMetadataParseOptions = {},
): InstalledCatalogState {
  const catalogPath = join(projectRoot, ".moeicons", "catalog.json");
  const metadataPath = join(projectRoot, ".moeicons", "install-metadata.json");
  const catalogExists = fs_.existsSync(catalogPath);
  const metadataExists = fs_.existsSync(metadataPath);

  // FIX-22-B: an installed project (metadata present) must have a parseable,
  // hash-consistent catalog. Only a truly un-installed project falls back to
  // the bundled contract.
  if (!catalogExists) {
    if (metadataExists) {
      return {
        status: "invalid",
        message:
          "install metadata exists but the catalog is missing; run 'moeicons install' to repair or reinstall",
      };
    }
    return { status: "absent" };
  }

  let catalog: IconCatalog;
  let catalogBytes: string;
  try {
    catalogBytes = fs_.readFileSync(catalogPath, "utf8");
    if (typeof catalogBytes !== "string")
      return { status: "invalid", message: "installed catalog is not text" };
    catalog = parseCatalog(JSON.parse(catalogBytes));
  } catch (error) {
    return {
      status: "invalid",
      message: `installed catalog cannot be parsed: ${error instanceof Error ? error.message : String(error)}; run 'moeicons install' to repair or reinstall`,
    };
  }

  if (!metadataExists) {
    return {
      status: "invalid",
      message:
        "installed catalog is present without install metadata; run 'moeicons install' to repair or reinstall",
    };
  }
  let metadata;
  try {
    const rawMetadata = fs_.readFileSync(metadataPath, "utf8");
    if (typeof rawMetadata !== "string") throw new Error("metadata is not text");
    metadata = parseInstallMetadata(rawMetadata, opts);
  } catch (error) {
    return {
      status: "invalid",
      message: `install metadata is invalid: ${error instanceof Error ? error.message : String(error)}; run 'moeicons install' to repair or reinstall`,
    };
  }
  if (!metadata) {
    return {
      status: "invalid",
      message:
        "install metadata could not be parsed; run 'moeicons install' to repair or reinstall",
    };
  }
  const actual = sha256Bytes(catalogBytes);
  const managed = metadata.managedFiles?.[".moeicons/catalog.json"];
  if (typeof metadata.catalogSha256 !== "string" || typeof managed !== "string") {
    return {
      status: "invalid",
      message:
        "install metadata is missing the catalog digest; run 'moeicons install' to repair or reinstall",
    };
  }
  if (metadata.catalogSha256 !== managed) {
    return {
      status: "invalid",
      message:
        "install metadata catalog digest is inconsistent; run 'moeicons install' to repair or reinstall",
    };
  }
  if (actual !== metadata.catalogSha256) {
    return {
      status: "invalid",
      message:
        "installed catalog hash does not match install metadata; run 'moeicons install' to repair or reinstall",
    };
  }
  return { status: "ok", catalog };
}

/** Backwards-compatible accessor used by tests: returns the catalog or undefined. */
export function loadInstalledCatalog(
  projectRoot: string,
  fs_: Pick<TransactionalFsWithCopy, "readFileSync" | "existsSync">,
): IconCatalog | undefined {
  const state = loadInstalledCatalogState(projectRoot, fs_);
  return state.status === "ok" ? state.catalog : undefined;
}

/** Vanilla/Assets generate from raw SVG; bitmap themes need variant binaries. */
function needsArchiveFiles(config: MoeiconsConfigFile, sourceCatalog?: IconCatalog): boolean {
  if (config.target === "vanilla" || config.target === "assets") return true;
  return hasBitmapThemes(config, sourceCatalog);
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

/** Unique bitmap variants the config selects, in canonical order. */
function requiredBitmapVariants(
  config: MoeiconsConfigFile,
  sourceCatalog?: IconCatalog,
): ResourceVariant[] {
  const resolved = resolveThemes(config, sourceCatalog);
  if (!resolved.ok) return [];
  const variants = resolved.themes
    .filter((theme) => theme.kind === "bitmap" && theme.variant)
    .flatMap((theme) => (theme.variant ? [theme.variant] : []));
  return [...new Map(variants.map((variant) => [variant.resourceVariantId, variant])).values()];
}

function archiveHasVariantAssets(
  archiveFiles: Readonly<Record<string, Uint8Array>>,
  variant: ResourceVariant,
  icons: readonly string[],
): boolean {
  return icons.every(
    (iconId) =>
      archiveFiles[`assets/${variant.resourceVariantId}/${iconId}.${variant.format}`] !== undefined,
  );
}

/**
 * DEV-G07: a v4 code archive carries no bitmap payload, so bitmap variants are
 * restored from the pinned shards. Only the config's selected tuples are read;
 * each cached shard is re-verified against its pinned identity (archive SHA,
 * manifest SHA, size, dimensions) before any bytes are handed to the generator.
 */
function mergePinnedBitmapShardAssets(
  archiveFiles: Record<string, Uint8Array>,
  effectiveConfig: MoeiconsConfigFile,
  sourceCatalog: IconCatalog | undefined,
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  fs_: TransactionalFsWithCopy,
): { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] } {
  const variants = requiredBitmapVariants(effectiveConfig, sourceCatalog);
  const missing = variants.filter(
    (variant) =>
      !archiveHasVariantAssets(
        archiveFiles,
        variant,
        effectiveConfig.icons.filter((iconId) =>
          Object.entries(effectiveConfig.themes).some(
            ([name, theme]) =>
              theme.styleGroup === variant.styleGroupId &&
              themeHasIcon(effectiveConfig, sourceCatalog ?? defaultCatalog, name, iconId) &&
              (() => {
                const resolved = resolveThemes(effectiveConfig, sourceCatalog);
                return (
                  resolved.ok &&
                  resolved.themes.some(
                    (item) =>
                      item.theme === name &&
                      item.variant?.resourceVariantId === variant.resourceVariantId,
                  )
                );
              })(),
          ),
        ),
      ),
  );
  if (missing.length === 0) return { ok: true };

  const metadataPath = join(projectRoot, ".moeicons", "install-metadata.json");
  if (!fs_.existsSync(metadataPath)) {
    return {
      ok: false,
      errors: ["bitmap shards require an installed pro artifact; run `moeicons install` first"],
    };
  }
  const metadata = parseInstallMetadata(fs_.readFileSync(metadataPath, "utf8"), {
    allowLocalTest: allowLocalTestFromEnv(env),
  });
  if (!metadata) {
    return {
      ok: false,
      errors: ["install metadata is invalid; run 'moeicons install' to repair or reinstall"],
    };
  }
  if (metadata.delivery?.mode === "icons") {
    return {
      ok: false,
      errors: [
        "selected bitmap resources are missing for this configuration; run `moeicons install` to download the configured icons, format and imageSize",
      ],
    };
  }
  if (!metadata.bitmapShards || metadata.bitmapShards.length === 0) {
    return {
      ok: false,
      errors: [
        "bitmap shards are not pinned in install metadata; run 'moeicons install' to repair or reinstall",
      ],
    };
  }
  const missingTuples = missing.map((variant) => ({
    styleGroupId: variant.styleGroupId,
    imageSize: { width: variant.imageSize, height: variant.imageSize },
    format: variant.format,
  }));
  const cacheDir = env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
  try {
    const loaded = loadPinnedBitmapShardAssets(metadata.bitmapShards, missingTuples, cacheDir, fs_);
    Object.assign(archiveFiles, loaded.files);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "bitmap shard verification failed"],
    };
  }
}

/**
 * Load installed artifact bytes for generate. Prefers `.moeicons/artifact/<target>/`
 * when that subtree already contains the assets the generator needs (assets target).
 * Vanilla (and bitmap themes on react/vue) need the full cached archive so
 * `assets/` is available — the installed package subtree alone is not enough.
 */
export async function loadArchiveFiles(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  fs_: Pick<TransactionalFsWithCopy, "readFileSync" | "existsSync" | "readdirSync">,
  injected?: Readonly<Record<string, Uint8Array>>,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly files: Readonly<Record<string, Uint8Array>> }
  | { readonly ok: false; readonly reason: string }> {
  if (injected) return { ok: true, files: injected };
  const fixtureTgz = env.MOEICONS_BITMAP_ARCHIVE;
  // DEV-G08: the aggregate-archive fixture is a local-test-only seam. It must
  // never bypass the shard contract in a production context, so a set variable
  // outside a local environment fails closed instead of being silently used.
  if (fixtureTgz && !allowLocalTestFromEnv(env)) {
    return { ok: false, reason: "MOEICONS_BITMAP_ARCHIVE is only honored in a local-test context" };
  }
  if (fixtureTgz && fs_.existsSync(fixtureTgz)) {
    const unpacked = await extractTarGzAsync(readBinaryFile(fs_, fixtureTgz), {
      maxEntries: ICON_ARCHIVE_MAX_ENTRIES,
      maxExpandedBytes: ICON_ARCHIVE_MAX_EXPANDED_BYTES,
    }, signal);
    if (unpacked.errors.length > 0)
      return { ok: false, reason: unpacked.errors[0] ?? "invalid bitmap archive fixture" };
    return { ok: true, files: unpacked.files };
  }
  const selectionMetadataPath = join(projectRoot, ".moeicons", "install-metadata.json");
  if (fs_.existsSync(selectionMetadataPath)) {
    const pinned = parseInstallMetadata(fs_.readFileSync(selectionMetadataPath, "utf8"), {
      allowLocalTest: allowLocalTestFromEnv(env),
    });
    if (pinned?.delivery?.mode === "icons") {
      const files: Record<string, Uint8Array> = {};
      for (const [name, hash] of Object.entries(pinned.managedFiles)) {
        if (!name.startsWith(".moeicons/artifact/")) continue;
        const target = safeManagedPath(projectRoot, name).target;
        if (!fs_.existsSync(target))
          return { ok: false, reason: `selected resource missing: ${name}; run moeicons install` };
        const bytes = readBinaryFile(fs_, target);
        if (sha256Bytes(bytes) !== hash)
          return {
            ok: false,
            reason: `selected resource modified: ${name}; preserve your edit before reinstalling`,
          };
        files[name.slice(".moeicons/artifact/".length)] = bytes;
      }
      return { ok: true, files };
    }
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
      if (
        Object.keys(files).length > 0 &&
        (meta.target === "assets" || archiveHasAssetsManifest(files))
      ) {
        return { ok: true, files };
      }
    }
  }
  const cacheDir = env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
  if (meta?.artifactVersion && meta.artifactSha256) {
    const cached = artifactCachePath(cacheDir, meta.artifactVersion, meta.artifactSha256);
    if (fs_.existsSync(cached)) {
      const unpacked = await extractTarGzAsync(readBinaryFile(fs_, cached), {
        maxEntries: ICON_ARCHIVE_MAX_ENTRIES,
        maxExpandedBytes: ICON_ARCHIVE_MAX_EXPANDED_BYTES,
      }, signal);
      if (unpacked.errors.length > 0)
        return { ok: false, reason: unpacked.errors[0] ?? "invalid cached artifact" };
      return { ok: true, files: unpacked.files };
    }
  }
  return { ok: false, reason: "installed artifact not found" };
}

// Keep the public asynchronous command contract while all filesystem work is synchronous.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runGenerateUseCase(
  context: CommandContext,
  fs_: TransactionalFsWithCopy,
  options: {
    readonly noTailwind?: boolean;
    readonly target?: Target;
    readonly archiveFiles?: Readonly<Record<string, Uint8Array>>;
    /** Kept for older callers; installed resources always reconcile through metadata. */
    readonly reconcileInstalled?: boolean;
  } = {},
): Promise<GenerateResult> {
  const project = detectProject(context.cwd);
  if (!project) return { ok: false, reason: "no-project" };
  const allowLocalTest = allowLocalTestFromEnv(context.env);
  const catalogState = loadInstalledCatalogState(project.root, fs_, { allowLocalTest });
  if (catalogState.status === "invalid") {
    return { ok: false, reason: "validation", errors: [catalogState.message] };
  }
  const sourceCatalog = catalogState.status === "ok" ? catalogState.catalog : undefined;
  const plannedConfigDocument = JSON.stringify(loadConfigDocument(project.root));
  const loaded = readMoeiconsConfig(project.root, sourceCatalog);
  if (loaded.kind === "invalid")
    return { ok: false, reason: "validation", errors: [loaded.message] };
  if (loaded.kind !== "ok") return { ok: false, reason: `config state: ${loaded.kind}` };

  const effectiveConfig = options.target
    ? { ...loaded.config, target: options.target }
    : loaded.config;
  const plannedMetadataPath = join(project.root, ".moeicons", "install-metadata.json");
  const plannedMetadataText = fs_.existsSync(plannedMetadataPath)
    ? fs_.readFileSync(plannedMetadataPath, "utf8")
    : undefined;
  const installedMeta = readInstallMetadata(project.root, fs_.readFileSync, fs_.existsSync);
  if (!installedMeta) {
    return {
      ok: false,
      reason:
        "generate requires an installed, version-pinned icon artifact; run 'moeicons install' first",
    };
  }
  if (installedMeta?.target && installedMeta.target !== effectiveConfig.target) {
    return {
      ok: false,
      reason: `installed artifact targets "${installedMeta.target}" while config targets "${effectiveConfig.target}"; set config target to "${effectiveConfig.target}" and run 'moeicons install ${loaded.config.tier} --target ${effectiveConfig.target}' before generate`,
    };
  }
  let archiveFiles: Readonly<Record<string, Uint8Array>> | undefined = options.archiveFiles;
  if (needsArchiveFiles(effectiveConfig, sourceCatalog) && archiveFiles === undefined) {
    const loadedArchive = await loadArchiveFiles(project.root, context.env, fs_, undefined, context.signal);
    if (!loadedArchive.ok) {
      return {
        ok: false,
        reason: "validation",
        errors: [missingArchiveMessage(effectiveConfig)],
      };
    }
    archiveFiles = loadedArchive.files;
  }
  if (archiveFiles !== undefined) {
    const merged: Record<string, Uint8Array> = { ...archiveFiles };
    const shardMerge = mergePinnedBitmapShardAssets(
      merged,
      effectiveConfig,
      sourceCatalog,
      project.root,
      context.env,
      fs_,
    );
    if (!shardMerge.ok) return { ok: false, reason: "validation", errors: [...shardMerge.errors] };
    archiveFiles = merged;
  }

  const plan = planGeneratedFiles(effectiveConfig, effectiveConfig.outputDir, {
    ...(archiveFiles ? { archiveFiles } : {}),
    ...(sourceCatalog ? { catalog: sourceCatalog } : {}),
  });
  if (!plan.ok) return { ok: false, reason: "validation", errors: plan.errors };

  const notes: string[] = [];
  const sideFiles: { path: string; content: string }[] = [];
  const expectedSideFiles: Record<string, string | undefined> = {};

  try {
    const tw = planTailwindIntegration(project.root, loaded.config.outputDir, {
      noTailwind: options.noTailwind === true,
      target: effectiveConfig.target,
    });
    notes.push(...tw.notes);
    sideFiles.push(...tw.files);
    for (const file of tw.files)
      expectedSideFiles[relative(project.root, file.path).replace(/\\/g, "/")] = fs_.existsSync(
        file.path,
      )
        ? sha256Bytes(fs_.readFileSync(file.path))
        : undefined;
  } catch (error) {
    if (isCliError(error) && error.code === "TAILWIND_VERSION_UNSUPPORTED") {
      return { ok: false, reason: error.message, code: error.code };
    }
    throw error;
  }

  const pkgPath = join(project.root, "package.json");
  if (fs_.existsSync(pkgPath)) {
    const pkgSource = fs_.readFileSync(pkgPath, "utf8");
    expectedSideFiles["package.json"] = sha256Bytes(pkgSource);
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
      const installCommand =
        project.packageManager === "pnpm"
          ? "pnpm install"
          : project.packageManager === "yarn"
            ? "yarn install"
            : project.packageManager === "npm"
              ? "npm install"
              : "your package manager's install command";
      notes.push(
        `package.json changed; run ${installCommand} to update the lockfile and install dependencies`,
      );
    }
  }

  try {
    return withProjectLockSync(project.root, "reload", () => {
      if (JSON.stringify(loadConfigDocument(project.root)) !== plannedConfigDocument)
        return { ok: false, reason: "config changed while preparing generate; retry" };
      const metadataPath = join(project.root, ".moeicons", "install-metadata.json");
      if (!fs_.existsSync(metadataPath))
        return {
          ok: false,
          reason:
            "managed install metadata is missing; run 'moeicons install' to repair or reinstall",
        };
      const metadata = parseInstallMetadata(fs_.readFileSync(metadataPath, "utf8"), {
        allowLocalTest,
      });
      if (fs_.readFileSync(metadataPath, "utf8") !== plannedMetadataText)
        return { ok: false, reason: "installation changed while preparing generate; retry" };
      if (!metadata || metadata.tier !== loaded.config.tier)
        return {
          ok: false,
          reason:
            "managed install metadata is invalid or does not match config tier; run 'moeicons install' to repair or reinstall",
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
          reason:
            "managed catalog hash is inconsistent; run 'moeicons install' to repair or reinstall",
        };

      const hasInstalledComponents = Object.keys(metadata.managedFiles).some(
        (path) =>
          path.startsWith(`.moeicons/artifact/${effectiveConfig.target}/`) && path.endsWith(".js"),
      );
      if (
        hasInstalledComponents &&
        (effectiveConfig.target === "react" || effectiveConfig.target === "vue")
      ) {
        const resolved = resolveThemes(effectiveConfig, sourceCatalog);
        if (!resolved.ok) return { ok: false, reason: resolved.errors.join("; ") };
        for (const iconId of effectiveConfig.icons) {
          for (const theme of resolved.themes) {
            const selected = resolveIconTheme(effectiveConfig, sourceCatalog!, theme.theme, iconId);
            if (!selected)
              return {
                ok: false,
                reason: `icon "${iconId}" has no selected variant for theme "${theme.theme}"`,
              };
            const group = effectiveConfig.themes[selected]!.styleGroup;
            const kind = resolved.themes.find(
              (candidate) => candidate.entry.styleGroup === group,
            )?.kind;
            if (kind === "bitmap") continue;
            const suffix = effectiveConfig.target === "vue" ? ".vue.js" : ".js";
            const rel = `.moeicons/artifact/${effectiveConfig.target}/${group}/${toProxyName(iconId)}${suffix}`;
            if (!fs_.existsSync(join(project.root, rel))) {
              return {
                ok: false,
                reason: `icon "${iconId}" is configured but its ${group} component is not installed (${rel}); run 'moeicons install' before generate`,
              };
            }
          }
        }
      }

      const outputPrefix = loaded.config.outputDir.replace(/\\/g, "/").replace(/\/$/, "") + "/";
      const previousPrefix =
        (metadata.generatedOutputDir ?? loaded.config.outputDir)
          .replace(/\\/g, "/")
          .replace(/\/$/, "") + "/";
      const generated = Object.fromEntries(
        plan.files.map((file) => [file.path.replace(/\\/g, "/"), file.content]),
      );
      for (const generatedPath of Object.keys(generated)) {
        if (
          fs_.existsSync(join(project.root, generatedPath)) &&
          !(generatedPath in metadata.managedFiles)
        ) {
          return {
            ok: false,
            reason: `generated path collides with an unowned user file: ${generatedPath}`,
          };
        }
      }
      const nextManaged: Record<string, string> = {};
      for (const [managedPath, hash] of Object.entries(metadata.managedFiles))
        if (!managedPath.startsWith(outputPrefix) && !managedPath.startsWith(previousPrefix))
          nextManaged[managedPath] = hash;
      for (const [path, content] of Object.entries(generated))
        nextManaged[path] = sha256Bytes(content);
      const nextMetadata: InstallMetadata = {
        ...metadata,
        managedFiles: nextManaged,
        generatedOutputDir: loaded.config.outputDir,
      };
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
        (path) =>
          (path.startsWith(outputPrefix) || path.startsWith(previousPrefix)) &&
          !(path in generated),
      );
      const expectedSha256: Record<string, string | undefined> = {
        ...metadata.managedFiles,
        ...expectedSideFiles,
        ".moeicons/install-metadata.json": sha256Bytes(fs_.readFileSync(metadataPath)),
      };
      for (const path of Object.keys(generated))
        if (!(path in expectedSha256)) expectedSha256[path] = undefined;
      executeManagedReconcile(project.root, writes, stale, fs_, { expectedSha256 });
      return {
        ok: true,
        files: plan.files.map((file) => file.path),
        ...(loaded.warnings.length > 0 || notes.length > 0
          ? { warnings: [...loaded.warnings, ...notes] }
          : {}),
      };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
