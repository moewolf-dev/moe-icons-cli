import { createInstallPlan, executeInstallPlan, type TransactionalFs } from "../project/install.js";
import { detectProject } from "../project/detect.js";
import { readMoeiconsConfig } from "../project/config.js";
import type { CommandContext } from "./context.js";
import type { PackageManager } from "../project/detect.js";
import { bundledSourceVersion, downloadFreeRelease, type FreeDownloadIo } from "./free-download.js";
import { serializeInstallMetadata, sha256Bytes } from "../project/install-metadata.js";
import { withProjectLock } from "../project/project-lock.js";
import type { Target } from "../commands/parser.js";
import { selectTargetSubtree } from "./target-subtree.js";

export type InstallResult =
  | {
      readonly ok: true;
      readonly projectRoot: string;
      readonly packageManager: PackageManager;
      readonly group: "free";
      readonly target: Target;
      readonly artifactBytes: number;
      readonly planItems: number;
      readonly config: string;
      readonly artifactVersion: string;
      readonly descriptorSha256: string;
      readonly catalogSha256: string;
      readonly cacheHit: boolean;
    }
  | { readonly ok: false; readonly reason: "no-project" }
  | { readonly ok: false; readonly reason: "cancelled"; readonly message: string }
  | { readonly ok: false; readonly reason: "checksum-mismatch"; readonly message: string }
  | { readonly ok: false; readonly reason: "network"; readonly message: string }
  | { readonly ok: false; readonly reason: "not-found"; readonly message: string }
  | { readonly ok: false; readonly reason: "offline-no-cache"; readonly message: string }
  | { readonly ok: false; readonly reason: "validation"; readonly message: string }
  | { readonly ok: false; readonly reason: "write-failed"; readonly message: string };

export interface InstallUseCaseDeps {
  readonly fs: TransactionalFs;
  readonly download: Omit<FreeDownloadIo, "signal">;
}

function normalizeGroup(group: string | undefined): "free" | "pro" {
  if (group === undefined || group === "free") return "free";
  if (group === "ent") return "pro";
  return group === "pro" ? "pro" : "free";
}

/**
 * Free install: resolve the catalog sourceVersion tag, download/verify the
 * GitHub Release (or a local release fixture), verify the selected target's
 * descriptor subtree, then transactionally write managed metadata plus the
 * selected target subtree. Pro installs route through the authenticated
 * `runProInstallUseCase`; this use case rejects them explicitly.
 */
export async function runInstallUseCase(
  context: CommandContext,
  deps: InstallUseCaseDeps,
  options: {
    readonly group?: string;
    readonly target?: Target;
    readonly sourceVersion?: string;
    readonly expectedDescriptorSha256?: string;
  },
): Promise<InstallResult> {
  const project = detectProject(context.cwd);
  if (!project) return { ok: false, reason: "no-project" };

  const groupArg = options.group;
  if (groupArg !== undefined && groupArg !== "free" && groupArg !== "pro" && groupArg !== "ent") {
    return { ok: false, reason: "validation", message: `unknown install group: ${groupArg}` };
  }
  const group = normalizeGroup(groupArg);
  if (group === "pro") {
    return {
      ok: false,
      reason: "validation",
      message: "pro install requires the authenticated pro flow",
    };
  }

  const config = readMoeiconsConfig(project.root);
  if (config.kind === "invalid" || config.kind === "unsupported") {
    return {
      ok: false,
      reason: "validation",
      message: config.kind === "invalid" ? config.message : `unsupported config schema version ${config.version}`,
    };
  }
  const target = options.target ?? (config.kind === "ok" ? config.config.target : "react");
  const downloaded = await downloadFreeRelease(
    { ...deps.download, signal: context.signal },
    options.sourceVersion ?? bundledSourceVersion(),
  );
  if (!downloaded.ok) {
    return downloaded.reason === "cancelled"
      ? { ok: false, reason: "cancelled", message: downloaded.message }
      : downloaded;
  }
  if (
    (options.sourceVersion && downloaded.descriptor.fullVersion !== options.sourceVersion) ||
    (options.expectedDescriptorSha256 &&
      downloaded.descriptorSha256 !== options.expectedDescriptorSha256)
  ) {
    return {
      ok: false,
      reason: "validation",
      message: "downloaded release identity changed after version check; retry the update",
    };
  }

  const subtree = selectTargetSubtree(downloaded.artifactBytes, downloaded.descriptor.free, target);
  if (!subtree.ok) {
    return subtree.reason === "checksum-mismatch"
      ? { ok: false, reason: "checksum-mismatch", message: subtree.message }
      : { ok: false, reason: "validation", message: subtree.message };
  }

  const catalogJson = downloaded.catalogJson;
  const files: Record<string, string | Uint8Array> = {
    ".moeicons/catalog.json": catalogJson,
    "src/moeicons/types.ts": `export type { ReactIconProps } from "moe-icons";\n`,
    "src/moeicons/.moeicons-free.marker": "free\n",
  };
  for (const [rel, bytes] of Object.entries(subtree.files)) {
    files[`.moeicons/artifact/${target}/${rel}`] = bytes;
  }
  const managedFiles = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, sha256Bytes(content)]),
  );
  files[".moeicons/install-metadata.json"] = serializeInstallMetadata({
    schemaVersion: 1,
    artifactVersion: downloaded.descriptor.fullVersion,
    tier: "free",
    target,
    descriptorSha256: downloaded.descriptorSha256,
    catalogSha256: downloaded.descriptor.catalog.sha256,
    artifactSha256: downloaded.descriptor.free.sha256,
    installedAt: context.now().toISOString(),
    managedFiles,
    targetSha256: subtree.sha256,
    targetFileCount: subtree.fileCount,
    targetByteCount: subtree.byteCount,
  });

  const plan = createInstallPlan(project.root, files);
  try {
    await withProjectLock(project.root, "install", () => executeInstallPlan(plan, deps.fs));
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    projectRoot: project.root,
    packageManager: project.packageManager,
    group: "free",
    target,
    artifactBytes: downloaded.artifactBytes.byteLength,
    planItems: plan.items.length,
    config: config.kind,
    artifactVersion: downloaded.descriptor.fullVersion,
    descriptorSha256: downloaded.descriptorSha256,
    catalogSha256: downloaded.descriptor.catalog.sha256,
    cacheHit: downloaded.cacheHit,
  };
}