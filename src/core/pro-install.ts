import { detectProject } from "../project/detect.js";
import { loadConfigDocument, validateConfigDocument } from "../project/config.js";
import { createInstallPlan, executeInstallPlan, type TransactionalFs, type TransactionalFsWithCopy } from "../project/install.js";
import { parseInstallMetadata, serializeInstallMetadata, sha256Bytes } from "../project/install-metadata.js";
import { withProjectLock } from "../project/project-lock.js";
import { runAccessTokenUseCase, type AuthUseCaseDependencies } from "./auth.js";
import type { CommandContext } from "./context.js";
import { downloadProArtifact, PRO_DOWNLOAD_HOSTS, resolveProDescriptorEndpoint } from "./pro-download.js";
import { artifactCachePath, metadataCachePath } from "./free-download.js";
import { selectTargetSubtree } from "./target-subtree.js";
import { typesReexport } from "./install.js";
import { CliError } from "../errors/index.js";
import type { Target } from "../commands/parser.js";
import { catalog as bundledCatalog, parseCatalog } from "../catalog/catalog.js";
import { resolveBitmapTuples, resolveConfiguredBitmapShards } from "./bitmap-shard-resolver.js";
import type { BitmapShard } from "./bitmap-shards.js";
import type { CacheIo } from "./cache.js";
import { allowLocalTestFromEnv } from "./local-test-env.js";

type ProInstallFs = TransactionalFs & Partial<Pick<TransactionalFsWithCopy, "readFileSync" | "readdirSync" | "copyFileSync">>;

function toCacheIo(fs_: ProInstallFs): CacheIo {
  return {
    // Shard cache keys are nested several levels deep; the CacheIo contract
    // requires recursive creation.
    mkdirSync: (path: string) => { fs_.mkdirSync(path, { recursive: true }); },
    writeFileSync: fs_.writeFileSync,
    renameSync: fs_.renameSync,
    existsSync: fs_.existsSync,
    rmSync: fs_.rmSync,
    ...(fs_.readFileSync ? { readFileSync: fs_.readFileSync } : {}),
    ...(fs_.readdirSync ? { readdirSync: fs_.readdirSync } : {}),
  };
}
import { homedir } from "node:os";
import { join } from "node:path";

function resolveCacheDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache");
}

/** Persist the full verified archive so vanilla/bitmap generate can read assets/. */
function cacheVerifiedArtifact(
  fs_: Pick<TransactionalFs, "existsSync" | "mkdirSync" | "writeFileSync">,
  cacheDir: string,
  version: string,
  sha256: string,
  bytes: Uint8Array,
  kind: "code" | "metadata" = "code",
): void {
  const cached =
    kind === "metadata"
      ? metadataCachePath(cacheDir, version, sha256)
      : artifactCachePath(cacheDir, version, sha256);
  if (fs_.existsSync(cached)) return;
  fs_.mkdirSync(join(cached, ".."), { recursive: true });
  fs_.writeFileSync(cached, bytes);
}

export async function runProInstallUseCase(
  context: CommandContext,
  deps: {
    readonly fs: ProInstallFs;
    readonly auth: AuthUseCaseDependencies;
    readonly fetch?: typeof fetch;
    readonly allowedHosts?: readonly string[];
    readonly onProgress?: (event: {
      readonly downloadedBytes: number;
      readonly totalBytes?: number;
    }) => void;
  },
  expected: {
    readonly version: string;
    readonly descriptorSha256: string;
    readonly target?: Target;
    /** A-1b: allow a declared local-test candidate (never true for production). */
    readonly allowLocalTest?: boolean;
  },
): Promise<{
  readonly projectRoot: string;
  readonly artifactVersion: string;
  readonly descriptorSha256: string;
  readonly catalogSha256: string;
  readonly artifactBytes: number;
}> {
  const project = detectProject(context.cwd);
  if (!project)
    throw new CliError(
      "VALIDATION_ERROR",
      "no package.json found in the current directory or parents",
    );
  // DEV-G10-R2: snapshot the config ONCE. Both the bootstrap and the strict
  // phase validate this same document, so a rewrite during download can never
  // combine an old target with new bitmap tuples.
  const document = loadConfigDocument(project.root);
  // DEV-G10-R1 phase 1: catalog-independent bootstrap. A Pro bitmap config
  // references groups the bundled catalog does not ship, so validate only the
  // safe fields (tier/target/syntax) before the release catalog is available.
  const bootstrap = validateConfigDocument(document, bundledCatalog, { lenientCatalog: true });
  if (bootstrap.kind !== "ok" || bootstrap.config.tier !== "pro")
    throw new CliError("VALIDATION_ERROR", "pro install requires a valid tier=pro config");
  const target = expected.target ?? bootstrap.config.target;
  const downloaded = await downloadProArtifact(
    context,
    deps.auth,
    { version: expected.version, descriptorSha256: expected.descriptorSha256, ...(expected.allowLocalTest === true ? { allowLocalTest: true } : {}) },
    {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.allowedHosts ? { allowedHosts: deps.allowedHosts } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    },
  );
  const subtree = selectTargetSubtree(downloaded.artifactBytes, downloaded.descriptor, target);
  if (!subtree.ok) {
    throw new CliError("VALIDATION_ERROR", subtree.message);
  }
  const cacheDir = resolveCacheDir(context.env);
  let bitmapPins: readonly BitmapShard[] | undefined;
  let bitmapShardSetSha256Value: string | undefined;
  let installedCatalog;
  try {
    installedCatalog = parseCatalog(JSON.parse(downloaded.catalogJson));
  } catch (error) {
    throw new CliError("VALIDATION_ERROR", error instanceof Error ? error.message : "invalid pro catalog");
  }
  // DEV-G10-R1 phase 2: re-validate the SAME snapshot against the verified
  // release catalog. A style group / icon / variant the release does not ship
  // fails closed here, before ANY cache write, shard fetch or metadata write.
  const strict = validateConfigDocument(document, installedCatalog);
  if (strict.kind !== "ok") {
    throw new CliError(
      "VALIDATION_ERROR",
      strict.kind === "invalid" ? strict.message : `config state: ${strict.kind}`,
    );
  }
  const config = strict.config;
  // Only after the snapshot passes strict validation do we persist the
  // content-addressed code/metadata caches. A rejected config writes nothing.
  cacheVerifiedArtifact(deps.fs, cacheDir, downloaded.descriptor.version, downloaded.descriptor.sha256, downloaded.artifactBytes);
  if (downloaded.metadataBytes && downloaded.descriptor.metadata) {
    cacheVerifiedArtifact(deps.fs, cacheDir, downloaded.descriptor.version, downloaded.descriptor.metadata.sha256, downloaded.metadataBytes, "metadata");
  }
  const resolvedTuples = resolveBitmapTuples(config, installedCatalog);
  if (!resolvedTuples.ok) throw new CliError("VALIDATION_ERROR", resolvedTuples.errors.join("; "));
  if (resolvedTuples.tuples.length > 0 && downloaded.descriptor.channel !== "local-test") {
    const accessToken = await runAccessTokenUseCase(context, deps.auth);
    const { loopbackHost } = resolveProDescriptorEndpoint(context.env);
    const allowedHosts = loopbackHost ? [...PRO_DOWNLOAD_HOSTS, loopbackHost] : PRO_DOWNLOAD_HOSTS;
    // DEV-G10: reuse verified pinned shards at the same resourceVersion so a
    // size switch only fetches the newly selected tuple. A version bump always
    // yields new shard identities, so no cross-version reuse is possible.
    let existingPins: readonly BitmapShard[] = [];
    const metadataPath = join(project.root, ".moeicons", "install-metadata.json");
    if (deps.fs.existsSync(metadataPath) && deps.fs.readFileSync) {
      const existing = parseInstallMetadata(deps.fs.readFileSync(metadataPath, "utf8"), { allowLocalTest: allowLocalTestFromEnv(context.env) });
      existingPins = (existing?.bitmapShards ?? []).filter((pin) => pin.resourceVersion === downloaded.descriptor.version);
    }
    const shards = await resolveConfiguredBitmapShards({
      existingPins,
      config,
      catalog: installedCatalog,
      version: downloaded.descriptor.version,
      descriptorSha256: downloaded.descriptor.descriptorSha256,
      cacheDir,
      io: toCacheIo(deps.fs),
      accessToken,
      allowedHosts,
      env: context.env,
      now: context.now().getTime(),
      signal: context.signal,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    bitmapPins = shards.pins;
    bitmapShardSetSha256Value = shards.bitmapShardSetSha256;
  }
  const files: Record<string, string | Uint8Array> = {
    ".moeicons/catalog.json": downloaded.catalogJson,
    ".moeicons/manifest.json": downloaded.manifestJson,
    ".moeicons/MANUAL.md": downloaded.manualMd,
    "src/moeicons/types.ts": typesReexport("pro", target),
    "src/moeicons/.moeicons-pro.marker": "pro\n",
  };
  for (const [rel, bytes] of Object.entries(subtree.files)) {
    files[`.moeicons/artifact/${target}/${rel}`] = bytes;
  }
  const managedFiles = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, sha256Bytes(content)]),
  );
  files[".moeicons/install-metadata.json"] = serializeInstallMetadata({
    schemaVersion: 1,
    artifactVersion: downloaded.descriptor.version,
    tier: "pro",
    target,
    descriptorSha256: downloaded.descriptor.descriptorSha256,
    artifactSha256: downloaded.descriptor.sha256,
    catalogSha256: downloaded.descriptor.catalogSha256,
    installedAt: context.now().toISOString(),
    managedFiles,
    targetSha256: subtree.sha256,
    targetFileCount: subtree.fileCount,
    targetByteCount: subtree.byteCount,
    ...(bitmapPins && bitmapShardSetSha256Value
      ? { bitmapShards: bitmapPins, bitmapShardSetSha256: bitmapShardSetSha256Value }
      : {}),
    // A-1b: record the accepted local-test model so a later generate can verify it.
    ...(downloaded.descriptor.channel === "local-test" ? { channel: "local-test" as const, publishable: false } : {}),
  });
  await withProjectLock(project.root, "install", () =>
    executeInstallPlan(createInstallPlan(project.root, files), deps.fs),
  );
  return {
    projectRoot: project.root,
    artifactVersion: downloaded.descriptor.version,
    descriptorSha256: downloaded.descriptor.descriptorSha256,
    catalogSha256: downloaded.descriptor.catalogSha256,
    artifactBytes: downloaded.artifactBytes.byteLength,
  };
}
