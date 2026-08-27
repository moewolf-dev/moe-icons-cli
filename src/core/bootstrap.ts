import { join } from "node:path";
import { homedir } from "node:os";
import { detectProject } from "../project/detect.js";
import { readInstalledResourceState } from "../project/install-metadata.js";
import type { TransactionalFs } from "../project/install.js";
import { runInstallUseCase } from "./install.js";
import type { CommandContext } from "./context.js";
import type { FreeDownloadIo } from "./free-download.js";

export interface BootstrapFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => string;
  readonly writeFileSync: (path: string, content: string) => void;
  readonly mkdirSync: (path: string) => void;
}

export interface BootstrapDeps {
  readonly fs: BootstrapFs;
  readonly installFs: TransactionalFs;
  readonly free: Omit<FreeDownloadIo, "signal">;
  readonly cliVersion: string;
}

export type BootstrapResult =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "already" }
  | { readonly kind: "installed"; readonly version: string }
  | { readonly kind: "failed"; readonly message: string; readonly retry: string };

export function bootstrapMarkerPath(env: Readonly<Record<string, string | undefined>>): string {
  return (
    env.MOEICONS_BOOTSTRAP_FILE ??
    join(env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache"), "bootstrap.json")
  );
}

function writeMarker(deps: BootstrapDeps, env: Readonly<Record<string, string | undefined>>, content: Record<string, unknown>): void {
  const marker = bootstrapMarkerPath(env);
  const body = `${JSON.stringify({ schemaVersion: 1, ...content }, null, 2)}\n`;
  const parent = marker.replace(/[\\/][^\\/]*$/, "") || "/";
  deps.fs.mkdirSync(parent);
  deps.fs.writeFileSync(marker, body);
}

/**
 * First-run bootstrap: on an interactive first start inside a project, install
 * Free code + Free metadata without an extra metadata prompt. The marker is
 * written only after a fully successful install (or when a valid free install
 * already exists), so a half-completed run never suppresses retry. A declined
 * prompt writes a `declined` marker so the CLI does not nag on every start.
 */
export async function runBootstrapUseCase(context: CommandContext, deps: BootstrapDeps): Promise<BootstrapResult> {
  if (!context.ui.confirm) return { kind: "skipped", reason: "non-interactive" };
  const marker = bootstrapMarkerPath(context.env);
  if (deps.fs.existsSync(marker)) return { kind: "already" };

  const project = detectProject(context.cwd);
  if (!project) return { kind: "skipped", reason: "no-project" };

  const state = readInstalledResourceState(project.root, "free");
  if (
    state.kind === "ok" &&
    deps.fs.existsSync(join(project.root, ".moeicons", "MANUAL.md")) &&
    deps.fs.existsSync(join(project.root, ".moeicons", "manifest.json"))
  ) {
    writeMarker(deps, context.env, { cliVersion: deps.cliVersion, libraryVersion: state.metadata.artifactVersion, completedAt: new Date().toISOString() });
    return { kind: "already" };
  }

  const confirmed = await context.ui.confirm(
    "Set up moeicons Free icons in this project now? (recommended)",
    context.signal,
  );
  if (confirmed !== true) {
    writeMarker(deps, context.env, { cliVersion: deps.cliVersion, declinedAt: new Date().toISOString() });
    return { kind: "skipped", reason: "declined" };
  }

  const result = await runInstallUseCase(
    context,
    { fs: deps.installFs, download: deps.free },
    {},
  );
  if (!result.ok) {
    if (result.reason === "no-project" || result.reason === "cancelled") {
      return { kind: "skipped", reason: result.reason };
    }
    return { kind: "failed", message: result.message, retry: "moeicons install free" };
  }
  writeMarker(deps, context.env, { cliVersion: deps.cliVersion, libraryVersion: result.artifactVersion, completedAt: new Date().toISOString() });
  return { kind: "installed", version: result.artifactVersion };
}
