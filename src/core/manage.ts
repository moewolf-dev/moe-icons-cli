import { readInstalledResourceState, type InstallMetadata } from "../project/install-metadata.js";
import { decideUpdate } from "./update-policy.js";
import { fetchLibraryVersions, type PublicLibraryVersions } from "./version-service.js";

export type LibraryVersionStatus =
  | { readonly kind: "installation-invalid"; readonly message: string }
  | { readonly kind: "check-failed"; readonly metadata: InstallMetadata; readonly message: string }
  | { readonly kind: "unavailable"; readonly metadata: InstallMetadata; readonly message: string }
  | { readonly kind: "current" | "update" | "channel-mismatch" | "remote-older"; readonly metadata: InstallMetadata; readonly latestVersion: string; readonly latestDescriptorSha256: string };

export async function getLibraryVersionStatus(projectRoot: string, configTier: "free" | "pro", deps: {
  readonly readState?: typeof readInstalledResourceState;
  readonly fetchVersions?: () => Promise<PublicLibraryVersions>;
} = {}): Promise<LibraryVersionStatus> {
  const installed = (deps.readState ?? readInstalledResourceState)(projectRoot, configTier);
  if (installed.kind !== "ok") return { kind: "installation-invalid", message: installed.message };
  let versions: PublicLibraryVersions;
  try { versions = await (deps.fetchVersions ?? (() => fetchLibraryVersions()))(); }
  catch (error) { return { kind: "check-failed", metadata: installed.metadata, message: error instanceof Error ? error.message : "version check failed" }; }
  const remote = versions[installed.metadata.tier];
  if (!remote) return { kind: "unavailable", metadata: installed.metadata, message: `no ${installed.metadata.tier} release is published` };
  const decision = decideUpdate({
    installedTier: installed.metadata.tier, remoteTier: installed.metadata.tier,
    installedVersion: installed.metadata.artifactVersion, remoteVersion: remote.version,
  });
  const identity = { metadata: installed.metadata, latestVersion: remote.version, latestDescriptorSha256: remote.descriptorSha256 };
  if (decision.kind === "current") return { kind: "current", ...identity };
  if (decision.kind === "update") return { kind: "update", ...identity };
  if (decision.reason === "channel-mismatch") return { kind: "channel-mismatch", ...identity };
  return { kind: "remote-older", ...identity };
}

export function formatLibraryVersionStatus(status: LibraryVersionStatus): string {
  if (status.kind === "installation-invalid") return `Current: invalid / Latest: unavailable / Status: installation invalid (${status.message})`;
  if (status.kind === "check-failed" || status.kind === "unavailable") return `Current: ${status.metadata.artifactVersion} / Latest: unavailable / Status: ${status.message}`;
  const label = status.kind === "current" ? "up to date" : status.kind === "update" ? "update available" : status.kind === "channel-mismatch" ? "prerelease channel differs" : "remote version is older";
  return `Current: ${status.metadata.artifactVersion} / Latest: ${status.latestVersion} / Status: ${label}`;
}
