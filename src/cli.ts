import { parseArgs, HELP_TEXT, type Command } from "./commands/parser.js";
import { CliError, isCliError, jsonErrorBody, type CliErrorCode } from "./errors/index.js";
import { detectProject } from "./project/detect.js";
import { readMoeiconsConfig } from "./project/config.js";
import { ensureClassMergeDependencies, planTailwindIntegration } from "./project/tailwind.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInitUseCase } from "./core/init.js";
import { runGenerateUseCase } from "./core/generate.js";
import { runInstallUseCase } from "./core/install.js";
import { runWizardUseCase } from "./core/wizard.js";
import type { CommandContext } from "./core/context.js";
import { createCommandUi } from "./ui/create-ui.js";
import { MOEICONS_BANNER, renderBannerText } from "./ui/banner.js";

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
}

function commandContext(runtime: CliRuntime, flags: { json: boolean; yes: boolean }): CommandContext {
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

export async function main(
  argv: readonly string[],
  runtime: CliRuntime,
): Promise<number> {
  await Promise.resolve();
  const jsonHint = argvRequestsJson(argv);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return reportFailure(runtime, jsonHint, error);
  }

  try {
    return await dispatchSync(parsed.command, runtime, parsed.json, parsed.yes, parsed.noTailwind);
  } catch (error) {
    return reportFailure(runtime, parsed.json, error);
  }
}

async function dispatchSync(
  command: Command,
  runtime: CliRuntime,
  json: boolean,
  yes: boolean,
  noTailwind: boolean,
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
      return await runInstall(command.group, runtime, json, noTailwind);
    case "login":
      throw new CliError("NOT_IMPLEMENTED", "login is not implemented yet");
    case "logout":
      throw new CliError("NOT_IMPLEMENTED", "logout is not implemented yet");
    case "account":
      throw new CliError("NOT_IMPLEMENTED", "account is not implemented yet");
    case "groups":
      throw new CliError("NOT_IMPLEMENTED", "groups is not implemented yet");
    case "generate":
      return runGenerate(runtime, json, noTailwind);
    case "init":
      return runInit(runtime, json);
    case "mcp":
      void runMcp(runtime);
      return 0;
  }
}

/** Create moeicons.config.jsonc if absent (never overwrites an existing config). */
function runInit(runtime: CliRuntime, json: boolean): number {
  const result = runInitUseCase(commandContext(runtime, { json, yes: false }), { mkdirSync, writeFileSync, existsSync, renameSync, rmSync });
  if (!result.ok && result.reason === "exists") {
    if (json) writeJson(runtime, { ok: true, alreadyExisted: true });
    else runtime.stdout("moeicons.config.jsonc already exists; not overwritten.\n");
    return 0;
  }
  if (!result.ok) {
    throw new CliError("VALIDATION_ERROR", result.reason === "no-project" ? "no project found" : "init failed");
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
  return "0.1.0";
}

/** Guided flow: Free / Pro / Login, with project-root confirmation before write. */
async function runWizard(runtime: CliRuntime, json: boolean, yes: boolean): Promise<number> {
  if (!json && runtime.isTTY()) {
    renderBanner(runtime);
  }
  const result = await runWizardUseCase(commandContext(runtime, { json, yes }), { json });
  if (result.ok && result.action === "json-hint") {
    writeJson(runtime, { ok: true, message: result.message });
    return 0;
  }
  if (!result.ok) {
    throw new CliError("CANCELLED", "cancelled");
  }
  if (result.action === "install") {
    const project = detectProject(runtime.cwd());
    if (project) runtime.stdout(`Project root: ${project.root}\n`);
    return await runInstall("free", runtime, false, false);
  }
  runtime.stdout(`Flow "${result.flow}" requires backend endpoints (pending BE-02/BE-04).\n`);
  return 0;
}

/** Free install orchestration: download/verify then map to JSON/human output. */
async function runInstall(
  group: string | undefined,
  runtime: CliRuntime,
  json: boolean,
  noTailwind: boolean,
): Promise<number> {
  const result = await runInstallUseCase(
    commandContext(runtime, { json, yes: false }),
    {
      fs: { mkdirSync, writeFileSync, existsSync, renameSync, rmSync },
      download: {
        fetchFn: globalThis.fetch.bind(globalThis),
        readFileSync: (path) => new Uint8Array(readFileSync(path)),
        writeFileSync: (path, data) => writeFileSync(path, data),
        mkdirSync: (path) => mkdirSync(path, { recursive: true }),
        existsSync,
        ...(runtime.env.MOEICONS_FREE_RELEASE_DIR
          ? { fixtureDir: runtime.env.MOEICONS_FREE_RELEASE_DIR }
          : {}),
        cacheDir: runtime.env.MOEICONS_CACHE_DIR ?? join(homedir(), ".moeicons", "cache"),
        cliVersion: versionString(),
      },
    },
    group === undefined ? {} : { group },
  );
  if (!result.ok && result.reason === "no-project") {
    throw new CliError("VALIDATION_ERROR", "no package.json found in the current directory or parents; run inside a project");
  }
  if (!result.ok && result.reason === "pro-not-implemented") {
    throw new CliError("NOT_IMPLEMENTED", "pro install is not implemented yet");
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
  if (!result.ok && result.reason === "validation") {
    throw new CliError("VALIDATION_ERROR", result.message);
  }
  if (!result.ok) {
    throw new CliError("UNEXPECTED", result.message);
  }

  // H1/H3: class-merge deps + optional Tailwind content (skipped with --no-tailwind).
  try {
    const pkgPath = join(result.projectRoot, "package.json");
    if (existsSync(pkgPath)) {
      const deps = ensureClassMergeDependencies(readFileSync(pkgPath, "utf8"));
      if (deps.changed) writeFileSync(pkgPath, deps.nextSource);
    }
    const config = readMoeiconsConfig(result.projectRoot);
    const outputDir = config.kind === "ok" ? config.config.outputDir : "src/moeicons";
    const tw = planTailwindIntegration(result.projectRoot, outputDir, { noTailwind });
    for (const file of tw.files) writeFileSync(file.path, file.content);
    if (!json && tw.notes.length > 0) {
      for (const note of tw.notes) runtime.stderr(`${note}\n`);
    }
  } catch (error) {
    if (isCliError(error) && error.code === "TAILWIND_VERSION_UNSUPPORTED") throw error;
    // Non-fatal for free download success: surface as unexpected only for unknown errors.
    if (isCliError(error)) throw error;
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
      cacheHit: result.cacheHit,
    });
  } else {
    runtime.stdout(`Project root: ${result.projectRoot}\n`);
    runtime.stdout(`Group: ${result.group}\n`);
    runtime.stdout(`Artifact: ${result.artifactVersion}\n`);
    runtime.stdout(`Config state: ${result.config}\n`);
    runtime.stdout(`Installed free artifact metadata to .moeicons (cacheHit=${String(result.cacheHit)}).\n`);
  }
  return 0;
}

function generateFailureCode(reason: string): CliErrorCode {
  if (reason === "validation" || reason === "no-project" || reason.startsWith("config state:")) {
    return "VALIDATION_ERROR";
  }
  return "UNEXPECTED";
}

/** Generate proxy components from config. */
function runGenerate(runtime: CliRuntime, json: boolean, noTailwind: boolean): number {
  const result = runGenerateUseCase(
    commandContext(runtime, { json, yes: false }),
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
    { noTailwind },
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
  if (json) writeJson(runtime, { ok: true, generated: result.files, ...(result.warnings ? { warnings: result.warnings } : {}) });
  else {
    runtime.stdout(`Generated ${result.files.length} files.\n`);
    if (result.warnings) {
      for (const warning of result.warnings) runtime.stderr(`${warning}\n`);
    }
  }
  return 0;
}
