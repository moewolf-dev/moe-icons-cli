import { fetchMoeiconsVersions, latestInChannel } from "./version-service.js";
import { decideUpdate } from "./update-policy.js";

export type InstallSource =
  | { readonly kind: "local"; readonly manager: "npm" | "pnpm" | "yarn" }
  | { readonly kind: "global"; readonly manager: "npm" | "pnpm" | "yarn" }
  | { readonly kind: "npx" }
  | { readonly kind: "unknown" };

export function detectInstallSource(input: { env: Readonly<Record<string, string | undefined>>; localManager?: "npm" | "pnpm" | "yarn"; localDependency?: boolean }): InstallSource {
  if (input.localDependency && input.localManager) return { kind: "local", manager: input.localManager };
  const agent = input.env.npm_config_user_agent ?? "";
  const manager = agent.startsWith("pnpm/") ? "pnpm" : agent.startsWith("yarn/") ? "yarn" : "npm";
  if (input.env.npm_command === "exec" || input.env.npm_lifecycle_event === "npx") return { kind: "npx" };
  if (input.env.npm_config_global === "true") return { kind: "global", manager };
  return { kind: "unknown" };
}

export function fixedUpdateInstruction(source: InstallSource, version: string): string {
  const spec = `moeicons@${version}`;
  if (source.kind === "npx") return `npx --yes ${spec}`;
  if (source.kind === "unknown") return `See https://moeicons.com/docs/cli-update for ${spec}`;
  if (source.kind === "local") {
    if (source.manager === "npm") return `npm install --save-exact ${spec}`;
    if (source.manager === "pnpm") return `pnpm add --save-exact ${spec}`;
    return `yarn add --exact ${spec}`;
  }
  if (source.manager === "npm") return `npm install --global ${spec}`;
  if (source.manager === "pnpm") return `pnpm add --global --save-exact ${spec}`;
  return `yarn global add --exact ${spec}`;
}

export function planCliUpdate(currentVersion: string, versions: readonly string[], source: InstallSource):
  { readonly status: "current" | "update" | "unavailable"; readonly currentVersion: string; readonly latestVersion?: string; readonly instruction?: string } {
  const latest = latestInChannel(currentVersion, versions);
  if (!latest) return { status: "unavailable", currentVersion };
  const decision = decideUpdate({ installedTier: "free", remoteTier: "free", installedVersion: currentVersion, remoteVersion: latest });
  if (decision.kind !== "update") return { status: "current", currentVersion, latestVersion: latest };
  return { status: "update", currentVersion, latestVersion: latest, instruction: fixedUpdateInstruction(source, latest) };
}

export interface CliUpdateFileSystem {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
}

export function detectLocalInstall(cwd: string, fs: CliUpdateFileSystem): { readonly localDependency: boolean; readonly localManager?: "npm" | "pnpm" | "yarn" } {
  let parsed: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } = {};
  try { parsed = JSON.parse(fs.readFileSync(`${cwd}/package.json`, "utf8")) as typeof parsed; } catch { return { localDependency: false }; }
  const localDependency = typeof parsed.dependencies?.moeicons === "string" || typeof parsed.devDependencies?.moeicons === "string";
  if (!localDependency) return { localDependency: false };
  if (fs.existsSync(`${cwd}/pnpm-lock.yaml`)) return { localDependency, localManager: "pnpm" };
  if (fs.existsSync(`${cwd}/yarn.lock`)) return { localDependency, localManager: "yarn" };
  if (fs.existsSync(`${cwd}/package-lock.json`)) return { localDependency, localManager: "npm" };
  return { localDependency };
}

/** Read-only update check. This module intentionally has no subprocess API. */
export async function runCliUpdateCheck(input: {
  readonly currentVersion: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: CliUpdateFileSystem;
  readonly signal?: AbortSignal;
  readonly fetchVersions?: () => Promise<readonly string[]>;
}): Promise<ReturnType<typeof planCliUpdate> & { readonly source: InstallSource }> {
  const local = detectLocalInstall(input.cwd, input.fs);
  const source = detectInstallSource({ env: input.env, ...local });
  const versions = await (input.fetchVersions ?? (() => fetchMoeiconsVersions({ ...(input.signal ? { signal: input.signal } : {}) })))();
  return { ...planCliUpdate(input.currentVersion, versions, source), source };
}
