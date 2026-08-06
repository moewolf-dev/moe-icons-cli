import { parseArgs, HELP_TEXT, type Command } from "./commands/parser.js";
import { CliError, isCliError } from "./errors/index.js";
import { detectProject } from "./project/detect.js";
import { readMoeiconsConfig } from "./project/config.js";
import { createInstallPlan, createArtifactZip } from "./project/install.js";
import { join } from "node:path";

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
}

export const BANNER = String.raw`
 ____  ___  _____  ___ ____ _   _ ____  _____ ____
/  _ \/ _ \|___ / / _ \___ \ \ / / _ \/ _  |___ / / _ \
| | | | | | | |_ \| | | |__) |\ V / | | | (_| | |_ \| | | |
| |_| | |_| |___) | |_| / __/  | || |_| |  _|  ___) | |_| |
\____/\___/|____/ \___/_____|  |_|\___/|_|  |____/ \___/
`;

/** Banner rendered as plain ASCII (fallback for narrow terminals). */
export function renderBanner(runtime: CliRuntime): void {
  runtime.stdout(BANNER);
  runtime.stdout("\nMoeicons icon library — CLI\n");
}

export async function main(
  argv: readonly string[],
  runtime: CliRuntime,
): Promise<number> {
  await Promise.resolve();
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (isCliError(error)) {
      runtime.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    runtime.stderr(`unexpected error: ${String(error)}\n`);
    return 5;
  }

  try {
    return dispatchSync(parsed.command, runtime, parsed.json);
  } catch (error) {
    if (isCliError(error)) {
      runtime.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    runtime.stderr(`unexpected error: ${String(error)}\n`);
    return 5;
  }
}

function dispatchSync(command: Command, runtime: CliRuntime, json: boolean): number {
  switch (command.name) {
    case "version":
      if (json) runtime.stdout(JSON.stringify({ version: versionString() }));
      else runtime.stdout(`${versionString()}\n`);
      return 0;
    case "help":
      runtime.stdout(HELP_TEXT);
      return 0;
    case "wizard":
      return runWizard(runtime, json);
    case "install":
      return runInstall(command.group, runtime, json);
    case "login":
      runtime.stdout(json ? JSON.stringify({ ok: true, message: "login flow placeholder" }) : "Login flow pending backend endpoints.\n");
      return 0;
    case "logout":
      runtime.stdout(json ? JSON.stringify({ ok: true }) : "Logged out (no session stored).\n");
      return 0;
    case "account":
      runtime.stdout(json ? JSON.stringify({ ok: true, tier: "unknown" }) : "Account info pending backend endpoints.\n");
      return 0;
    case "groups":
      runtime.stdout(json ? JSON.stringify({ ok: true, groups: [] }) : "No groups available yet.\n");
      return 0;
    case "generate":
      return runGenerate(runtime, json);
    case "mcp":
      void runMcp(runtime);
      return 0;
  }
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
function runWizard(runtime: CliRuntime, json: boolean): number {
  renderBanner(runtime);
  if (json) {
    runtime.stdout(JSON.stringify({ ok: true, message: "interactive wizard unavailable in JSON mode; use install/login/account/groups/generate" }));
    return 0;
  }
  runtime.stdout("Choose an option:\n");
  runtime.stdout("  1) Install moeicons free\n");
  runtime.stdout("  2) Install moeicons pro (API key)\n");
  runtime.stdout("  3) Login\n");
  runtime.stdout("\nInteractive prompts require a TTY; run a specific command with --json for noninteractive use.\n");
  return 0;
}

/** Free/group install orchestration. */
function runInstall(group: string | undefined, runtime: CliRuntime, json: boolean): number {
  const cwd = runtime.cwd();
  const project = detectProject(cwd);
  if (!project) {
    throw new CliError("VALIDATION_ERROR", "no package.json found in the current directory or parents; run inside a project");
  }

  const config = readMoeiconsConfig(project.root);

  const files: Record<string, string> = {};
  const groupId = group ?? "free";
  files["src/moeicons/types.ts"] = `export type { ReactIconProps } from "moe-icons";\n`;
  files[`src/moeicons/.moeicons-${groupId}.marker`] = `${groupId}\n`;

  const plan = createInstallPlan(join(project.root, "src/moeicons"), files);
  const zip = createArtifactZip(files);

  if (json) {
    runtime.stdout(
      JSON.stringify({
        ok: true,
        projectRoot: project.root,
        packageManager: project.packageManager,
        group: groupId,
        zipBytes: zip.byteLength,
        planItems: plan.items.length,
        config: config.kind,
      }),
    );
  } else {
    runtime.stdout(`Project root: ${project.root}\n`);
    runtime.stdout(`Group: ${groupId}\n`);
    runtime.stdout(`Config state: ${config.kind}\n`);
    runtime.stdout("Install flow pending backend download + transactional execution.\n");
  }
  return 0;
}

/** Generate proxy components from config. */
function runGenerate(runtime: CliRuntime, json: boolean): number {
  const cwd = runtime.cwd();
  const project = detectProject(cwd);
  if (!project) {
    throw new CliError("VALIDATION_ERROR", "no project found");
  }
  const config = readMoeiconsConfig(project.root);
  if (json) {
    runtime.stdout(JSON.stringify({ ok: true, config: config.kind, generated: [] }));
  } else {
    runtime.stdout(`Config state: ${config.kind}\n`);
    runtime.stdout("Generation pending (CLI-13/CLI-14).\n");
  }
  return 0;
}
