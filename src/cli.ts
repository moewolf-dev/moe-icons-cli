import { parseArgs, HELP_TEXT, type Command } from "./commands/parser.js";
import { CliError, isCliError, jsonErrorBody, type CliErrorCode } from "./errors/index.js";
import { detectProject } from "./project/detect.js";
import { readMoeiconsConfig } from "./project/config.js";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
  copyFileSync,
  statfsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInitUseCase } from "./core/init.js";
import { runGenerateUseCase } from "./core/generate.js";
import { runInstallUseCase } from "./core/install.js";
import { runWizardUseCase } from "./core/wizard.js";
import type { CommandContext } from "./core/context.js";
import { createCommandUi } from "./ui/create-ui.js";
import { CLI_VERSION, MOEICONS_BANNER, renderBannerText, renderNoticeBox } from "./ui/banner.js";
import {
  runAccountUseCase,
  runLoginUseCase,
  runLogoutUseCase,
  runSessionStatusUseCase,
  type AuthUseCaseDependencies,
} from "./core/auth.js";
import { formatLibraryVersionStatus, getLibraryVersionStatus } from "./core/manage.js";
import { runCliUpdateCheck } from "./core/cli-update.js";
import { fetchLibraryVersions } from "./core/version-service.js";
import { runProInstallUseCase } from "./core/pro-install.js";
import { runLibraryUpdateUseCase } from "./core/library-update.js";
import { runMetadataSyncUseCase } from "./core/metadata-sync.js";
import { runBootstrapUseCase } from "./core/bootstrap.js";
import { fetchProDescriptor } from "./core/pro-download.js";
import { proResourceState, runProPredownloadUseCase } from "./core/pro-resources.js";
import { formatBytes } from "./metadata/version.js";
import type { FreeDownloadIo } from "./core/free-download.js";

/**
 * main(argv, runtime): parse args, select command/default wizard, catch typed
 * errors, render once, return exit code. Only the executable wrapper calls
 * process.exitCode.
 */

export interface CliRuntime {
  readonly cwd: () => string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: () => boolean;
  readonly readLine?: (prompt: string) => Promise<string>;
  readonly readKey?: () => Promise<string>;
  readonly auth?: AuthUseCaseDependencies;
  readonly fetchVersions?: () => Promise<readonly string[]>;
}

function commandContext(
  runtime: CliRuntime,
  flags: { json: boolean; yes: boolean },
): CommandContext {
  const streams =
    runtime.readLine !== undefined && runtime.readKey !== undefined
      ? {
          isTTY: runtime.isTTY,
          stdout: runtime.stdout,
          readLine: runtime.readLine,
          readKey: runtime.readKey,
        }
      : undefined;
  return {
    ui: createCommandUi({
      json: flags.json,
      yes: flags.yes,
      isTTY: runtime.isTTY(),
      ...(streams ? { streams } : {}),
    }),
    cwd: runtime.cwd(),
    env: runtime.env,
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

function freeDownloadDeps(runtime: CliRuntime): Omit<FreeDownloadIo, "signal"> {
  return {
    fetchFn: globalThis.fetch.bind(globalThis),
    readFileSync: (path) => new Uint8Array(readFileSync(path)),
    writeFileSync: (path, data) => writeFileSync(path, data),
    mkdirSync: (path) => mkdirSync(path, { recursive: true }),
    existsSync,
    renameSync,
    rmSync,
    statfs: (dir) => {
      try {
        const stats = statfsSync(dir);
        return { availableBytes: stats.bavail * stats.bsize };
      } catch {
        return undefined;
      }
    },
    ...(runtime.env.MOEICONS_FREE_RELEASE_DIR
      ? { fixtureDir: runtime.env.MOEICONS_FREE_RELEASE_DIR }
      : {}),
    cacheDir: runtime.env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache"),
    cliVersion: versionString(),
  };
}

export { MOEICONS_BANNER };
export const BANNER = MOEICONS_BANNER;

/** Banner rendered as plain ASCII (fallback for narrow terminals). */
export function renderBanner(runtime: CliRuntime): void {
  runtime.stdout(renderBannerText());
}

function argvRequestsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function writeJson(runtime: CliRuntime, value: unknown): void {
  runtime.stdout(JSON.stringify(value));
}

function reportFailure(runtime: CliRuntime, json: boolean, error: unknown): number {
  if (isCliError(error)) {
    if (json) writeJson(runtime, jsonErrorBody(error.code, error.message));
    else runtime.stderr(`error: ${error.message}\n`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) writeJson(runtime, jsonErrorBody("UNEXPECTED", message));
  else runtime.stderr(`unexpected error: ${message}\n`);
  return 5;
}

export async function main(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  await Promise.resolve();
  const jsonHint = argvRequestsJson(argv);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return reportFailure(runtime, jsonHint, error);
  }

  if (parsed.command.name === "wizard" && !parsed.json && runtime.isTTY() && runtime.readLine === undefined) {
    await runBootstrap(runtime);
  }

  try {
    return await dispatchSync(
      parsed.command,
      runtime,
      parsed.json,
      parsed.yes,
      parsed.noTailwind,
      parsed.target,
    );
  } catch (error) {
    return reportFailure(runtime, parsed.json, error);
  }
}

async function runBootstrap(runtime: CliRuntime): Promise<void> {
  const context = commandContext(runtime, { json: false, yes: false });
  try {
    const result = await runBootstrapUseCase(context, {
      fs: {
        existsSync,
        readFileSync: (path) => readFileSync(path, "utf8"),
        writeFileSync: (path, content) => writeFileSync(path, content),
        mkdirSync: (path) => mkdirSync(path, { recursive: true }),
      },
      installFs: { mkdirSync, writeFileSync, existsSync, renameSync, rmSync },
      free: freeDownloadDeps(runtime),
      cliVersion: versionString(),
    });
    if (result.kind === "installed") {
      runtime.stdout(`Installed moeicons Free v${result.version} with metadata into the current project.\n`);
    } else if (result.kind === "failed") {
      runtime.stderr(`warning: automatic Free setup failed: ${result.message}\nRun: ${result.retry}\n`);
    }
  } catch {
    // Bootstrap must never block the wizard.
  }
}

async function dispatchSync(
  command: Command,
  runtime: CliRuntime,
  json: boolean,
  yes: boolean,
  noTailwind: boolean,
  target?: "react" | "vue" | "vanilla" | "assets",
): Promise<number> {
  switch (command.name) {
    case "version":
      if (json) writeJson(runtime, { ok: true, version: versionString() });
      else runtime.stdout(`${versionString()}\n`);
      return 0;
    case "help":
      runtime.stdout(HELP_TEXT);
      return 0;
    case "wizard":
      return await runWizard(runtime, json, yes);
    case "install":
      return await runInstall(
        command.group,
        runtime,
        json,
        noTailwind,
        undefined,
        undefined,
        command.target,
      );
    case "login":
      return await runLogin(runtime, json, yes);
    case "logout":
      return await runLogout(runtime, json);
    case "account":
      return await runAccount(runtime, json);
    case "groups":
      throw new CliError("NOT_IMPLEMENTED", "groups is not implemented yet");
    case "generate":
      return await runGenerate(runtime, json, noTailwind, false, target, yes);
    case "init":
      return runInit(runtime, json, target);
    case "mcp":
      void runMcp(runtime);
      return 0;
    case "update":
      return await runUpdate(runtime, json, yes, command.metadata === true);
  }
}

async function runLogin(runtime: CliRuntime, json: boolean, yes: boolean): Promise<number> {
  const session = await runLoginUseCase(commandContext(runtime, { json, yes }), {
    ...runtime.auth,
    fileFallbackAllowed: runtime.isTTY(),
  });
  if (json) writeJson(runtime, { ok: true, account: session });
  else runtime.stdout(`Logged in as ${session.accountId}\n`);
  if (!json && runtime.isTTY()) await offerProPredownload(runtime);
  return 0;
}

/**
 * After a successful interactive login, offer to pre-download the full Pro
 * code + metadata. Cancelling or a failed probe never logs the user out.
 */
async function offerProPredownload(runtime: CliRuntime): Promise<void> {
  const context = commandContext(runtime, { json: false, yes: false });
  try {
    const versions = await fetchLibraryVersions({
      ...(runtime.auth?.fetch ? { fetch: runtime.auth.fetch } : {}),
      signal: context.signal,
      env: runtime.env,
    });
    if (!versions.pro) {
      runtime.stdout("No Pro release is published yet.\n");
      return;
    }
    const descriptor = await fetchProDescriptor(
      context,
      runtime.auth ?? {},
      { version: versions.pro.version, descriptorSha256: versions.pro.descriptorSha256 },
      runtime.auth?.fetch ? { fetch: runtime.auth.fetch } : {},
    );
    const sizes = `${formatBytes(descriptor.size)} code + ${
      descriptor.metadata ? formatBytes(descriptor.metadata.size) : "0 B"
    } metadata`;
    runtime.stdout(`Pro ${versions.pro.version} available (${sizes}).\n`);
    const accepted = await context.ui.confirm("Download Pro resources now? (code + metadata)", context.signal);
    if (accepted !== true) {
      runtime.stdout("Skipped Pro download; you can download it later from the home screen.\n");
      return;
    }
    const progress = context.ui.progress("Downloading Pro resources", context.signal);
    try {
      const result = await runProPredownloadUseCase(context, runtime.auth ?? {}, {
        ...(runtime.auth?.fetch ? { fetch: runtime.auth.fetch } : {}),
        onProgress: ({ downloadedBytes, totalBytes }) =>
          progress.update?.(
            `Downloaded ${downloadedBytes} bytes${totalBytes ? ` of ${totalBytes}` : ""}`,
          ),
      });
      progress.stop("Pro resources downloaded");
      runtime.stdout(`Cached Pro ${result.version} code + metadata.\n`);
    } catch (error) {
      progress.stop("Pro download stopped");
      runtime.stderr(
        `warning: Pro download failed (${error instanceof Error ? error.message : String(error)}). You can retry from the home screen.\n`,
      );
    }
  } catch {
    // A failed probe must not make login fail.
  }
}

/**
 * Home-screen Pro resources flow: show the current cache state and drive the
 * matching action (download / update / repair / verify). Requires auth.
 */
async function runProResources(runtime: CliRuntime, yes: boolean): Promise<number> {
  const context = commandContext(runtime, { json: false, yes });
  const fetchDeps = runtime.auth?.fetch ? { fetch: runtime.auth.fetch } : {};
  const state = await proResourceState(context, runtime.auth ?? {}, fetchDeps);
  if (state.kind === "unavailable") {
    runtime.stdout(`Pro resources unavailable: ${state.reason}\n`);
    return 0;
  }
  let action = "";
  if (state.kind === "current") {
    runtime.stdout(`Pro resources are up to date (v${state.version}).\n`);
    return 0;
  }
  if (state.kind === "not-cached") {
    runtime.stdout(
      `Pro ${state.version}: ${formatBytes(state.codeBytes)} code + ${formatBytes(state.metadataBytes)} metadata.\n`,
    );
    action = "Download";
  } else if (state.kind === "outdated") {
    runtime.stdout(
      `Pro ${state.version} → ${state.latestVersion}: ${formatBytes(state.codeBytes)} code + ${formatBytes(state.metadataBytes)} metadata.\n`,
    );
    action = "Update";
  } else {
    runtime.stdout(`Pro ${state.version} cache is corrupt; re-downloading.\n`);
    action = "Repair";
  }
  const confirmed = await context.ui.confirm(`${action} Pro resources now? (code + metadata)`, context.signal);
  if (confirmed !== true) {
    runtime.stdout("Cancelled; Pro resources were not downloaded.\n");
    return 0;
  }
  const progress = context.ui.progress("Downloading Pro resources", context.signal);
  try {
    const result = await runProPredownloadUseCase(context, runtime.auth ?? {}, {
      ...fetchDeps,
      force: state.kind === "corrupt",
      onProgress: ({ downloadedBytes, totalBytes }) =>
        progress.update?.(
          `Downloaded ${downloadedBytes} bytes${totalBytes ? ` of ${totalBytes}` : ""}`,
        ),
    });
    progress.stop("Pro resources downloaded");
    runtime.stdout(`Cached Pro ${result.version} code + metadata.\n`);
    return 0;
  } catch (error) {
    progress.stop("Pro download stopped");
    if (error instanceof CliError && (error.code === "FORBIDDEN" || error.code === "AUTH_ERROR")) {
      throw error;
    }
    runtime.stderr(
      `warning: Pro download failed (${error instanceof Error ? error.message : String(error)}). Retry from this menu.\n`,
    );
    return 0;
  }
}

async function runAccount(runtime: CliRuntime, json: boolean): Promise<number> {
  const session = await runAccountUseCase(
    commandContext(runtime, { json, yes: false }),
    runtime.auth,
  );
  if (json) writeJson(runtime, { ok: true, account: session });
  else
    runtime.stdout(
      `Account: ${session.accountId}\nSession expires: ${new Date(session.expiresAt).toISOString()}\n`,
    );
  return 0;
}

async function runLogout(runtime: CliRuntime, json: boolean): Promise<number> {
  const result = await runLogoutUseCase(
    commandContext(runtime, { json, yes: false }),
    runtime.auth,
  );
  if (json) writeJson(runtime, { ok: true, ...result });
  else
    runtime.stdout(
      result.revoked
        ? "Logged out.\n"
        : "Logged out locally; remote revocation was not confirmed.\n",
    );
  return 0;
}

/** Create moeicons.config.jsonc if absent (never overwrites an existing config). */
function runInit(
  runtime: CliRuntime,
  json: boolean,
  target?: "react" | "vue" | "vanilla" | "assets",
): number {
  const result = runInitUseCase(
    commandContext(runtime, { json, yes: false }),
    { mkdirSync, writeFileSync, existsSync, renameSync, rmSync },
    target,
  );
  if (!result.ok && result.reason === "exists") {
    if (json) writeJson(runtime, { ok: true, alreadyExisted: true });
    else runtime.stdout("moeicons.config.jsonc already exists; not overwritten.\n");
    return 0;
  }
  if (!result.ok) {
    throw new CliError(
      "VALIDATION_ERROR",
      result.reason === "no-project" ? "no project found" : "init failed",
    );
  }
  if (json) writeJson(runtime, { ok: true, created: result.created });
  else runtime.stdout(`Created ${result.created}\n`);
  return 0;
}

/** Start the MCP stdio server; protocol data to stdout, logs to stderr. */
async function runMcp(runtime: CliRuntime): Promise<void> {
  const { runMcpStdio } = await import("./mcp/server.js");
  const readline = await import("node:readline");
  const services = {
    listIconGroups: () =>
      Promise.resolve([
        { id: "free", displayName: "Free icons" },
        { id: "pro", displayName: "Pro icons" },
      ]),
    getAccount: () => Promise.resolve(undefined),
    installIconGroup: (args: { groupId: string; projectPath: string }) => {
      runtime.stderr(`installing ${args.groupId} into ${args.projectPath} (stub)\n`);
      return Promise.resolve({ ok: true, message: `installed ${args.groupId}` });
    },
  };
  const rl = readline.createInterface({ input: process.stdin });
  await runMcpStdio({ services, stdout: runtime.stdout, stderr: runtime.stderr, lines: rl });
}

function versionString(): string {
  return CLI_VERSION;
}

function renderCliUpdateNotice(update: Awaited<ReturnType<typeof runCliUpdateCheck>>): string {
  const latest = update.latestVersion ?? "unavailable";
  const instruction = update.instruction ?? (update.status === "current" ? "already up to date" : "unavailable");
  const prompt = update.status === "update"
    ? "A newer Moeicons CLI is available. Update with the command below."
    : "Moeicons CLI version status";
  return renderNoticeBox([
    prompt,
    `Current ${update.currentVersion} / Latest ${latest} / Update: ${instruction}`,
  ]);
}

/** Guided flow: Free / Pro / Login, with project-root confirmation before write. */
async function runWizard(runtime: CliRuntime, json: boolean, yes: boolean): Promise<number> {
  if (!json && runtime.isTTY()) {
    renderBanner(runtime);
    runtime.stdout(`CLI ${versionString()}\n`);
    try {
      const update = await runCliUpdateCheck({
        currentVersion: versionString(),
        cwd: runtime.cwd(),
        env: runtime.env,
        fs: { existsSync, readFileSync: (path) => readFileSync(path, "utf8") },
        timeoutMs: 1_000,
        ...(runtime.fetchVersions ? { fetchVersions: runtime.fetchVersions } : {}),
      });
      runtime.stdout(`${renderCliUpdateNotice(update)}\n`);
    } catch {
      runtime.stdout(`${renderNoticeBox(["Moeicons CLI version status", `Current ${versionString()} / Latest unavailable / Update: unavailable`])}\n`);
    }
  }
  const context = commandContext(runtime, { json, yes });
  const session = await runSessionStatusUseCase(context, runtime.auth).catch((error: unknown) => ({
    kind: "unknown" as const,
    reason: error instanceof Error ? error.message : "session status unavailable",
  }));
  const getStatus = async () => {
    const project = detectProject(runtime.cwd());
    if (!project) return "Current: invalid / Latest: unavailable / Status: no project";
    const config = readMoeiconsConfig(project.root);
    if (config.kind !== "ok")
      return `Current: invalid / Latest: unavailable / Status: config ${config.kind}`;
    return formatLibraryVersionStatus(
      await getLibraryVersionStatus(project.root, config.config.tier),
    );
  };
  const result = await runWizardUseCase(context, {
    json,
    session: session.kind,
    getLibraryStatus: getStatus,
    getProResourceLabel: async () => {
      if (session.kind !== "authenticated") return undefined;
      const state = await proResourceState(context, runtime.auth ?? {}, {
        ...(runtime.auth?.fetch ? { fetch: runtime.auth.fetch } : {}),
      }).catch(() => undefined);
      if (!state || state.kind === "unavailable") return undefined;
      if (state.kind === "not-cached") return "Download Pro resources";
      if (state.kind === "outdated")
        return `Update Pro resources (${state.version} → ${state.latestVersion})`;
      if (state.kind === "corrupt") return "Repair Pro resources";
      return "Pro resources are up to date";
    },
  });
  if (result.ok && result.action === "json-hint") {
    writeJson(runtime, { ok: true, message: result.message });
    return 0;
  }
  if (!result.ok) {
    throw new CliError("CANCELLED", "cancelled");
  }
  if (result.action === "pro-resources") {
    return await runProResources(runtime, yes);
  }
  if (result.action === "install") {
    const project = detectProject(runtime.cwd());
    if (project) runtime.stdout(`Project root: ${project.root}\n`);
    return await runInstall(
      result.group,
      runtime,
      false,
      false,
      undefined,
      undefined,
      result.target,
    );
  }
  if (result.action === "settings") {
    if (result.flow === "logout") return runLogout(runtime, false);
    const update = await runCliUpdateCheck({
      currentVersion: versionString(),
      cwd: runtime.cwd(),
      env: runtime.env,
      fs: { existsSync, readFileSync: (path) => readFileSync(path, "utf8") },
      signal: context.signal,
      timeoutMs: 1_000,
      ...(runtime.fetchVersions ? { fetchVersions: runtime.fetchVersions } : {}),
    }).catch(() => undefined);
    if (!update) {
      runtime.stdout(`${renderNoticeBox(["Moeicons CLI version status", `Current ${versionString()} / Latest unavailable / Update: unavailable`])}\n`);
      return 0;
    }
    if (update.status === "update")
      runtime.stdout(
        `CLI ${update.currentVersion} → ${update.latestVersion}\nRun: ${update.instruction}\n`,
      );
    else if (update.status === "current")
      runtime.stdout(`CLI ${update.currentVersion} is up to date.\n`);
    else runtime.stdout(`Unable to find a CLI release in the current channel.\n`);
    return 0;
  }
  if (result.action === "manage") {
    if (result.flow === "reload") return await runGenerate(runtime, false, false, true, undefined, yes);
    const project = detectProject(runtime.cwd());
    if (!project) throw new CliError("VALIDATION_ERROR", "no project found");
    const config = readMoeiconsConfig(project.root);
    if (config.kind !== "ok") throw new CliError("VALIDATION_ERROR", `config ${config.kind}`);
    const status = await getLibraryVersionStatus(project.root, config.config.tier);
    runtime.stdout(`${formatLibraryVersionStatus(status)}\n`);
    if (status.kind !== "update") return 0;
    return runLibraryUpdate(
      runtime,
      status.metadata.tier,
      status.latestVersion,
      status.latestDescriptorSha256,
    );
  }
  if (result.flow === "login") return runLogin(runtime, false, yes);
  return 0;
}

async function runLibraryUpdate(
  runtime: CliRuntime,
  tier: "free" | "pro",
  version: string,
  descriptorSha256: string,
): Promise<number> {
  const context = commandContext(runtime, { json: false, yes: false });
  const progress = context.ui.progress("Downloading icon library update", context.signal);
  try {
    const result = await runLibraryUpdateUseCase(
      context,
      {
        fs: {
          mkdirSync,
          writeFileSync,
          readFileSync,
          existsSync,
          renameSync,
          rmSync,
          readdirSync,
          copyFileSync,
        },
        free: freeDownloadDeps(runtime),
        auth: runtime.auth ?? {},
        fetch: runtime.auth?.fetch ?? globalThis.fetch.bind(globalThis),
        onProgress: ({ downloadedBytes, totalBytes }) =>
          progress.update?.(
            `Downloaded ${downloadedBytes} bytes${totalBytes ? ` of ${totalBytes}` : ""}`,
          ),
      },
      { tier, version, descriptorSha256 },
    );
    progress.stop("Icon library update complete");
    runtime.stdout(
      `Updated ${tier} artifact to ${result.artifactVersion}; reconciled ${result.files.length} generated files.\n`,
    );
    return 0;
  } catch (error) {
    progress.stop("Icon library update stopped");
    throw error;
  }
}

/**
 * `update` command: `update metadata` syncs only the small metadata archive for
 * the installed version; `update` performs a full code + metadata update.
 */
async function runUpdate(
  runtime: CliRuntime,
  json: boolean,
  yes: boolean,
  metadataOnly: boolean,
): Promise<number> {
  const context = commandContext(runtime, { json, yes });
  if (metadataOnly) {
    try {
      const result = await runMetadataSyncUseCase(
        context,
        {
          fs: {
            mkdirSync,
            writeFileSync,
            readFileSync,
            existsSync,
            renameSync,
            rmSync,
            readdirSync,
            copyFileSync,
          },
          free: freeDownloadDeps(runtime),
          auth: runtime.auth ?? {},
          ...(runtime.auth?.fetch ? { fetch: runtime.auth.fetch } : {}),
        },
        {},
      );
      if (json) writeJson(runtime, { ok: true, ...result });
      else
        runtime.stdout(
          `Synced ${result.tier} metadata ${result.artifactVersion} into ${result.projectRoot}.\n`,
        );
      return 0;
    } catch (error) {
      if (json) return reportFailure(runtime, true, error);
      throw error;
    }
  }
  const project = detectProject(runtime.cwd());
  if (!project) throw new CliError("VALIDATION_ERROR", "no project found; run install first");
  const config = readMoeiconsConfig(project.root);
  if (config.kind !== "ok") throw new CliError("VALIDATION_ERROR", `config ${config.kind}`);
  const status = await getLibraryVersionStatus(project.root, config.config.tier);
  if (status.kind !== "update") {
    if (json) writeJson(runtime, { ok: true, status: status.kind });
    else runtime.stdout(`${formatLibraryVersionStatus(status)}\n`);
    return 0;
  }
  return runLibraryUpdate(runtime, status.metadata.tier, status.latestVersion, status.latestDescriptorSha256);
}

/** Free install orchestration: download/verify then map to JSON/human output. */
async function runInstall(
  group: string | undefined,
  runtime: CliRuntime,
  json: boolean,
  noTailwind: boolean,
  sourceVersion?: string,
  expectedDescriptorSha256?: string,
  target?: "react" | "vue" | "vanilla" | "assets",
): Promise<number> {
  const context = commandContext(runtime, { json, yes: false });
  const progress = context.ui.progress("Downloading icon library", context.signal);
  if (group === "pro" || group === "ent") {
    const identity =
      sourceVersion && expectedDescriptorSha256
        ? { version: sourceVersion, descriptorSha256: expectedDescriptorSha256 }
        : await fetchLibraryVersions({
            signal: context.signal,
            env: runtime.env,
            ...(runtime.auth?.fetch ? { fetch: runtime.auth.fetch } : {}),
          }).then((versions) => {
            if (!versions.pro) throw new CliError("NOT_FOUND", "no pro release is published");
            return {
              version: versions.pro.version,
              descriptorSha256: versions.pro.descriptorSha256,
            };
          });
    try {
      const result = await runProInstallUseCase(
        context,
        {
          fs: { mkdirSync, writeFileSync, existsSync, renameSync, rmSync },
          auth: runtime.auth ?? {},
          fetch: runtime.auth?.fetch ?? globalThis.fetch.bind(globalThis),
          onProgress: ({ downloadedBytes, totalBytes }) => {
            const percent = totalBytes
              ? ` (${Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))}%)`
              : "";
            progress.update?.(
              `Downloaded ${downloadedBytes} bytes${totalBytes ? ` of ${totalBytes}` : ""}${percent}`,
            );
          },
        },
        { ...identity, ...(target ? { target } : {}) },
      );
      progress.stop("Icon library download complete");
      if (json) writeJson(runtime, { ok: true, group: "pro", ...result });
      else
        runtime.stdout(
          `Installed pro artifact ${result.artifactVersion} into ${result.projectRoot}.\n`,
        );
      return 0;
    } catch (error) {
      progress.stop("Icon library download stopped");
      throw error;
    }
  }
  const result = await runInstallUseCase(
    context,
    {
      fs: { mkdirSync, writeFileSync, existsSync, renameSync, rmSync },
      download: {
        ...freeDownloadDeps(runtime),
        onProgress: ({ downloadedBytes, totalBytes }) => {
          const percent = totalBytes
            ? ` (${Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))}%)`
            : "";
          progress.update?.(
            `Downloaded ${downloadedBytes} bytes${totalBytes ? ` of ${totalBytes}` : ""}${percent}`,
          );
        },
      },
    },
    {
      ...(group === undefined ? {} : { group }),
      ...(target ? { target } : {}),
      ...(sourceVersion ? { sourceVersion } : {}),
      ...(expectedDescriptorSha256 ? { expectedDescriptorSha256 } : {}),
    },
  );
  progress.stop(result.ok ? "Icon library download complete" : "Icon library download stopped");
  if (!result.ok && result.reason === "no-project") {
    throw new CliError(
      "VALIDATION_ERROR",
      "no package.json found in the current directory or parents; run inside a project",
    );
  }
  if (!result.ok && result.reason === "cancelled") {
    throw new CliError("CANCELLED", result.message);
  }
  if (!result.ok && result.reason === "checksum-mismatch") {
    throw new CliError("VALIDATION_ERROR", result.message);
  }
  if (!result.ok && (result.reason === "network" || result.reason === "offline-no-cache")) {
    throw new CliError("NETWORK_ERROR", result.message);
  }
  if (!result.ok && result.reason === "not-found") {
    throw new CliError("NOT_FOUND", result.message);
  }
  if (!result.ok && result.reason === "disk-full") {
    throw new CliError("DISK_FULL", result.message);
  }
  if (!result.ok && result.reason === "validation") {
    throw new CliError("VALIDATION_ERROR", result.message);
  }
  if (!result.ok) {
    throw new CliError("UNEXPECTED", result.message);
  }

  if (json) {
    writeJson(runtime, {
      ok: true,
      projectRoot: result.projectRoot,
      packageManager: result.packageManager,
      group: result.group,
      zipBytes: result.artifactBytes,
      artifactBytes: result.artifactBytes,
      planItems: result.planItems,
      config: result.config,
      artifactVersion: result.artifactVersion,
      descriptorSha256: result.descriptorSha256,
      catalogSha256: result.catalogSha256,
      metadataSha256: result.metadataSha256,
      cacheHit: result.cacheHit,
    });
  } else {
    runtime.stdout(`Project root: ${result.projectRoot}\n`);
    runtime.stdout(`Group: ${result.group}\n`);
    runtime.stdout(`Artifact: ${result.artifactVersion}\n`);
    runtime.stdout(`Config state: ${result.config}\n`);
    runtime.stdout(
      `Installed free artifact metadata to .moeicons (cacheHit=${String(result.cacheHit)}).\n`,
    );
  }
  return 0;
}

function generateFailureCode(reason: string): CliErrorCode {
  if (reason === "cancelled") return "CANCELLED";
  if (reason === "validation" || reason === "no-project" || reason.startsWith("config state:")) {
    return "VALIDATION_ERROR";
  }
  return "UNEXPECTED";
}

/** Generate proxy components from config. */
async function runGenerate(
  runtime: CliRuntime,
  json: boolean,
  noTailwind: boolean,
  reconcileInstalled = false,
  target?: "react" | "vue" | "vanilla" | "assets",
  yes = false,
): Promise<number> {
  const result = await runGenerateUseCase(
    commandContext(runtime, { json, yes }),
    {
      mkdirSync,
      writeFileSync,
      readFileSync,
      existsSync,
      renameSync,
      rmSync,
      readdirSync,
      copyFileSync,
    },
    { noTailwind, reconcileInstalled, ...(target ? { target } : {}) },
  );
  if (!result.ok) {
    if (result.code === "TAILWIND_VERSION_UNSUPPORTED") {
      if (json) writeJson(runtime, jsonErrorBody("TAILWIND_VERSION_UNSUPPORTED", result.reason));
      else runtime.stderr(`error: ${result.reason}\n`);
      return 1;
    }
    const code = generateFailureCode(result.reason);
    const message = result.reason;
    if (json) {
      writeJson(runtime, {
        ...jsonErrorBody(code, message),
        ...(result.errors ? { errors: result.errors } : {}),
      });
    } else {
      runtime.stderr(`error: ${message}\n`);
      if (result.errors) {
        for (const item of result.errors) runtime.stderr(`${item}\n`);
      }
    }
    return 1;
  }
  if (json)
    writeJson(runtime, {
      ok: true,
      generated: result.files,
      ...(result.warnings ? { warnings: result.warnings } : {}),
    });
  else {
    runtime.stdout(`Generated ${result.files.length} files.\n`);
    if (result.warnings) {
      for (const warning of result.warnings) runtime.stderr(`${warning}\n`);
    }
  }
  return 0;
}
