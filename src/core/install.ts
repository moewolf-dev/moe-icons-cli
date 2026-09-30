import { createInstallPlan, executeInstallPlan, type TransactionalFs } from "../project/install.js";
import { detectProject } from "../project/detect.js";
import { readMoeiconsConfig, loadConfigDocument } from "../project/config.js";
import type { CommandContext } from "./context.js";
import type { PackageManager } from "../project/detect.js";
import { CliError, isCliError } from "../errors/index.js";
import { bundledSourceVersion, downloadFreeRelease, type FreeDownloadIo } from "./free-download.js";
import { serializeInstallMetadata, sha256Bytes } from "../project/install-metadata.js";
import { withProjectLock } from "../project/project-lock.js";
import type { Target } from "../commands/parser.js";
import {
  configuredComponentFiles,
  selectTargetSubtree,
  computeSubtreeHash,
} from "./target-subtree.js";
import { parseCatalog } from "../catalog/catalog.js";
import { posix } from "node:path";

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
      readonly metadataSha256: string;
      readonly cacheHit: boolean;
      readonly downloadMode?: "icons" | "full";
      readonly downloadNotes?: readonly string[];
      readonly networkBytes?: number;
      readonly selectedFiles?: number;
    }
  | { readonly ok: false; readonly reason: "no-project" }
  | { readonly ok: false; readonly reason: "cancelled"; readonly message: string }
  | { readonly ok: false; readonly reason: "checksum-mismatch"; readonly message: string }
  | { readonly ok: false; readonly reason: "network"; readonly message: string }
  | { readonly ok: false; readonly reason: "not-found"; readonly message: string }
  | { readonly ok: false; readonly reason: "offline-no-cache"; readonly message: string }
  | { readonly ok: false; readonly reason: "disk-full"; readonly message: string }
  | { readonly ok: false; readonly reason: "validation"; readonly message: string }
  | { readonly ok: false; readonly reason: "write-failed"; readonly message: string };

export interface InstallUseCaseDeps {
  readonly fs: TransactionalFs;
  readonly download: Omit<FreeDownloadIo, "signal">;
}

/**
 * P0-3: the project `types.ts` must re-export a type that actually exists in the
 * installed `moe-icons` package. Assets have no component type, so it is empty.
 */
export function typesReexport(
  tier: "free" | "pro",
  target: Target,
  outputDir = "src/moeicons",
): string {
  void tier;
  const from = posix.relative(outputDir.replace(/\\/g, "/"), `.moeicons/artifact/${target}/types`);
  const specifier = from.startsWith(".") ? from : `./${from}`;
  if (target === "react") return `export type { ReactIconProps } from "${specifier}";\n`;
  if (target === "vue") return `export type { VueIconProps } from "${specifier}";\n`;
  if (target === "vanilla") return `export type { VanillaIconOptions } from "${specifier}";\n`;
  return "export {};\n";
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
    // AUD-CL-01: single style-group install (`moeicons install <styleGroupId>`)
    // is not supported. Fail closed with explicit guidance instead of silently
    // treating an unknown group as Free.
    return {
      ok: false,
      reason: "validation",
      message: `unknown install group "${groupArg}"; single style-group install is not supported — run "moeicons install free" or "moeicons install pro"`,
    };
  }
  const group = normalizeGroup(groupArg);
  if (group === "pro") {
    return {
      ok: false,
      reason: "validation",
      message: "pro install requires the authenticated pro flow",
    };
  }

  const document = loadConfigDocument(project.root);
  const plannedConfigDocument = JSON.stringify(document);
  const config = readMoeiconsConfig(project.root, undefined, { lenientCatalog: true });
  if (config.kind === "invalid" || config.kind === "unsupported") {
    return {
      ok: false,
      reason: "validation",
      message:
        config.kind === "invalid"
          ? config.message
          : `unsupported config schema version ${config.version}`,
    };
  }
  if (config.kind === "ok" && config.config.tier !== "free")
    return {
      ok: false,
      reason: "validation",
      message:
        'config.tier is pro; run "moeicons install pro" or change tier to free before downloading',
    };
  const target = options.target ?? (config.kind === "ok" ? config.config.target : "react");
  if (config.kind === "ok" && config.config.target !== target) {
    return {
      ok: false,
      reason: "validation",
      message: `config target is "${config.config.target}" but install target is "${target}"; set target to "${target}" in moeicons.config before installing`,
    };
  }
  const downloaded = await downloadFreeRelease(
    { ...deps.download, signal: context.signal },
    options.sourceVersion ?? bundledSourceVersion(),
    config.kind === "ok"
      ? {
          config: config.config,
          document,
          onPlan: (message) => context.ui.note(message, context.signal),
        }
      : undefined,
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

  const selectedTarget = downloaded.selected
    ? Object.fromEntries(
        Object.entries(downloaded.selected.files)
          .filter(([path]) => path.startsWith(`${target}/`))
          .map(([path, bytes]) => [path.slice(target.length + 1), bytes]),
      )
    : undefined;
  const subtree = selectedTarget
    ? { ok: true as const, target, files: selectedTarget, ...computeSubtreeHash(selectedTarget) }
    : selectTargetSubtree(downloaded.artifactBytes, downloaded.descriptor.free, target);
  if (!subtree.ok) {
    return subtree.reason === "checksum-mismatch"
      ? { ok: false, reason: "checksum-mismatch", message: subtree.message }
      : { ok: false, reason: "validation", message: subtree.message };
  }
  let installedFiles: Readonly<Record<string, Uint8Array>>;
  try {
    installedFiles = downloaded.selected
      ? subtree.files
      : configuredComponentFiles(
          subtree.files,
          target,
          config.kind === "ok" ? config.config : undefined,
          parseCatalog(JSON.parse(downloaded.catalogJson)),
        );
  } catch (error) {
    return {
      ok: false,
      reason: "validation",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const catalogJson = downloaded.catalogJson;
  const outputDir =
    config.kind === "ok"
      ? config.config.outputDir.replace(/\\/g, "/").replace(/\/$/, "")
      : "src/moeicons";
  const files: Record<string, string | Uint8Array> = {
    ".moeicons/catalog.json": catalogJson,
    ".moeicons/manifest.json": downloaded.manifestJson,
    ".moeicons/MANUAL.md": downloaded.manualMd,
    ".moeicons/artifact/package.json": '{"private":true,"type":"module","sideEffects":false}\n',
    [`${outputDir}/types.ts`]: typesReexport("free", target, outputDir),
    [`${outputDir}/.moeicons-free.marker`]: "free\n",
  };
  for (const [rel, bytes] of Object.entries(installedFiles)) {
    files[`.moeicons/artifact/${target}/${rel}`] = bytes;
  }
  if (downloaded.selected) {
    files[".moeicons/resource-index.json.gz"] = downloaded.selected.indexBytes;
    for (const [rel, bytes] of Object.entries(downloaded.selected.files))
      files[`.moeicons/artifact/${rel}`] = bytes;
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
    ...(downloaded.selected
      ? {
          delivery: {
            mode: "icons" as const,
            indexSha256: downloaded.selected.refs.index.sha256,
            bundleSha256: downloaded.selected.refs.bundle.sha256,
          },
        }
      : {}),
    targetSha256: subtree.sha256,
    targetFileCount: subtree.fileCount,
    targetByteCount: subtree.byteCount,
    // Local-test candidates record the declared model so a later generate can
    // verify the install state (mirrors the Pro install path).
    ...(downloaded.descriptor.channel === "local-test"
      ? { channel: "local-test" as const, publishable: false }
      : {}),
  });

  const plan = createInstallPlan(project.root, files);
  try {
    await withProjectLock(project.root, "install", () => {
      if (JSON.stringify(loadConfigDocument(project.root)) !== plannedConfigDocument)
        throw new CliError("VALIDATION_ERROR", "config changed while preparing install; retry");
      executeInstallPlan(plan, deps.fs);
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        isCliError(error) && error.code === "VALIDATION_ERROR" ? "validation" : "write-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    projectRoot: project.root,
    packageManager: project.packageManager,
    group: "free",
    target,
    artifactBytes: downloaded.selected?.payloadBytes ?? downloaded.artifactBytes.byteLength,
    downloadMode: downloaded.selected ? "icons" : "full",
    ...(downloaded.selected
      ? {
          networkBytes: downloaded.selected.networkBytes,
          selectedFiles: Object.keys(downloaded.selected.files).length,
        }
      : {}),
    downloadNotes:
      downloaded.selected?.fallbacks ??
      (config.kind === "ok" && config.config.downloadMode !== "full"
        ? [
            "This release does not support selected downloads; used the verified full archive. Set downloadMode=icons to require selected downloads.",
          ]
        : config.kind === "ok"
          ? []
          : [
              "No config was found; installed the full archive. Run moeicons init, select icons/themes, then reinstall for selected downloads.",
            ]),
    planItems: plan.items.length,
    config: config.kind,
    artifactVersion: downloaded.descriptor.fullVersion,
    descriptorSha256: downloaded.descriptorSha256,
    catalogSha256: downloaded.descriptor.catalog.sha256,
    metadataSha256: downloaded.metadataSha256,
    cacheHit: downloaded.cacheHit,
  };
}
