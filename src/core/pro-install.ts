import { detectProject } from "../project/detect.js";
import { readMoeiconsConfig } from "../project/config.js";
import { createInstallPlan, executeInstallPlan, type TransactionalFs } from "../project/install.js";
import { serializeInstallMetadata, sha256Bytes } from "../project/install-metadata.js";
import { withProjectLock } from "../project/project-lock.js";
import type { AuthUseCaseDependencies } from "./auth.js";
import type { CommandContext } from "./context.js";
import { downloadProArtifact } from "./pro-download.js";
import { CliError } from "../errors/index.js";

export async function runProInstallUseCase(context: CommandContext, deps: {
  readonly fs: TransactionalFs;
  readonly auth: AuthUseCaseDependencies;
  readonly fetch?: typeof fetch;
  readonly allowedHosts?: readonly string[];
  readonly onProgress?: (event: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void;
}, expected: { readonly version: string; readonly descriptorSha256: string }): Promise<{
  readonly projectRoot: string; readonly artifactVersion: string; readonly descriptorSha256: string; readonly catalogSha256: string; readonly artifactBytes: number;
}> {
  const project = detectProject(context.cwd);
  if (!project) throw new CliError("VALIDATION_ERROR", "no package.json found in the current directory or parents");
  const config = readMoeiconsConfig(project.root);
  if (config.kind !== "ok" || config.config.tier !== "pro") throw new CliError("VALIDATION_ERROR", "pro install requires a valid tier=pro config");
  const downloaded = await downloadProArtifact(context, deps.auth, expected, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.allowedHosts ? { allowedHosts: deps.allowedHosts } : {}), ...(deps.onProgress ? { onProgress: deps.onProgress } : {}) });
  const files: Record<string, string> = {
    ".moeicons/catalog.json": downloaded.catalogJson,
    "src/moeicons/types.ts": `export type { ReactIconProps } from "moe-icons";\n`,
    "src/moeicons/.moeicons-pro.marker": "pro\n",
  };
  const managedFiles = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256Bytes(content)]));
  files[".moeicons/install-metadata.json"] = serializeInstallMetadata({
    schemaVersion: 1, artifactVersion: downloaded.descriptor.version, tier: "pro",
    descriptorSha256: downloaded.descriptor.descriptorSha256, artifactSha256: downloaded.descriptor.sha256,
    catalogSha256: downloaded.descriptor.catalogSha256, installedAt: context.now().toISOString(), managedFiles,
  });
  await withProjectLock(project.root, "install", () => executeInstallPlan(createInstallPlan(project.root, files), deps.fs));
  return { projectRoot: project.root, artifactVersion: downloaded.descriptor.version, descriptorSha256: downloaded.descriptor.descriptorSha256, catalogSha256: downloaded.descriptor.catalogSha256, artifactBytes: downloaded.artifactBytes.byteLength };
}
