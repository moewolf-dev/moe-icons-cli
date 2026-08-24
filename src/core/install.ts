import { createInstallPlan, executeInstallPlan, type TransactionalFs } from "../project/install.js";
import { detectProject } from "../project/detect.js";
import { readMoeiconsConfig } from "../project/config.js";
import type { CommandContext } from "./context.js";
import type { PackageManager } from "../project/detect.js";
import { bundledSourceVersion, downloadFreeRelease, type FreeDownloadIo } from "./free-download.js";

export type InstallResult =
  | {
      readonly ok: true;
      readonly projectRoot: string;
      readonly packageManager: PackageManager;
      readonly group: "free";
      readonly artifactBytes: number;
      readonly planItems: number;
      readonly config: string;
      readonly artifactVersion: string;
      readonly descriptorSha256: string;
      readonly catalogSha256: string;
      readonly cacheHit: boolean;
    }
  | { readonly ok: false; readonly reason: "no-project" }
  | { readonly ok: false; readonly reason: "pro-not-implemented" }
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

function installMetadata(options: {
  artifactVersion: string;
  descriptorSha256: string;
  catalogSha256: string;
  artifactSha256: string;
  installedAt: string;
  files: Readonly<Record<string, string>>;
}): string {
  return `${JSON.stringify(
    {
      artifactVersion: options.artifactVersion,
      tier: "free",
      descriptorSha256: options.descriptorSha256,
      artifactSha256: options.artifactSha256,
      catalogSha256: options.catalogSha256,
      installedAt: options.installedAt,
      files: options.files,
    },
    null,
    2,
  )}\n`;
}

/**
 * Free install: resolve the catalog sourceVersion tag, download/verify the
 * GitHub Release (or a local release fixture), then transactionally write
 * managed metadata. Pro remains unimplemented until F4.
 */
export async function runInstallUseCase(
  context: CommandContext,
  deps: InstallUseCaseDeps,
  options: { readonly group?: string },
): Promise<InstallResult> {
  const project = detectProject(context.cwd);
  if (!project) return { ok: false, reason: "no-project" };

  const groupArg = options.group;
  if (groupArg !== undefined && groupArg !== "free" && groupArg !== "pro" && groupArg !== "ent") {
    return { ok: false, reason: "validation", message: `unknown install group: ${groupArg}` };
  }
  const group = normalizeGroup(groupArg);
  if (group === "pro") return { ok: false, reason: "pro-not-implemented" };

  const config = readMoeiconsConfig(project.root);
  const downloaded = await downloadFreeRelease(
    { ...deps.download, signal: context.signal },
    bundledSourceVersion(),
  );
  if (!downloaded.ok) {
    return downloaded.reason === "cancelled"
      ? { ok: false, reason: "cancelled", message: downloaded.message }
      : downloaded;
  }

  const catalogJson = downloaded.catalogJson.endsWith("\n")
    ? downloaded.catalogJson
    : `${downloaded.catalogJson}\n`;
  const files: Record<string, string> = {
    ".moeicons/catalog.json": catalogJson,
    "src/moeicons/types.ts": `export type { ReactIconProps } from "moe-icons";\n`,
    "src/moeicons/.moeicons-free.marker": "free\n",
  };
  files[".moeicons/install-metadata.json"] = installMetadata({
    artifactVersion: downloaded.descriptor.fullVersion,
    descriptorSha256: downloaded.descriptorSha256,
    catalogSha256: downloaded.descriptor.catalog.sha256,
    artifactSha256: downloaded.descriptor.free.sha256,
    installedAt: context.now().toISOString(),
    files: {
      ".moeicons/catalog.json": downloaded.descriptor.catalog.sha256,
      "src/moeicons/.moeicons-free.marker": "free",
      "src/moeicons/types.ts": "types",
    },
  });

  const plan = createInstallPlan(project.root, files);
  try {
    executeInstallPlan(plan, deps.fs);
  } catch (error) {
    return { ok: false, reason: "write-failed", message: error instanceof Error ? error.message : String(error) };
  }

  return {
    ok: true,
    projectRoot: project.root,
    packageManager: project.packageManager,
    group: "free",
    artifactBytes: downloaded.artifactBytes.byteLength,
    planItems: plan.items.length,
    config: config.kind,
    artifactVersion: downloaded.descriptor.fullVersion,
    descriptorSha256: downloaded.descriptorSha256,
    catalogSha256: downloaded.descriptor.catalog.sha256,
    cacheHit: downloaded.cacheHit,
  };
}
