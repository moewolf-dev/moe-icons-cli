import { parseArgs, HELP_TEXT, type Command } from "./commands/parser.js";
import { CliError, isCliError } from "./errors/index.js";
import { detectProject } from "./project/detect.js";
import { readMoeiconsConfig, createMoeiconsConfig } from "./project/config.js";
import { createInstallPlan, createArtifactZip, executeInstallPlan } from "./project/install.js";
import { planGeneratedFiles } from "./generator/generate.js";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { select, confirm, CancelledError } from "./tui/primitives.js";

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
  readonly readLine: (prompt: string) => Promise<string>;
  readonly readKey: () => Promise<string>;
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
    return await dispatchSync(parsed.command, runtime, parsed.json);
  } catch (error) {
    if (isCliError(error)) {
      runtime.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    runtime.stderr(`unexpected error: ${String(error)}\n`);
    return 5;
  }
}

async function dispatchSync(command: Command, runtime: CliRuntime, json: boolean): Promise<number> {
  switch (command.name) {
    case "version":
      if (json) runtime.stdout(JSON.stringify({ version: versionString() }));
      else runtime.stdout(`${versionString()}\n`);
      return 0;
    case "help":
      runtime.stdout(HELP_TEXT);
      return 0;
    case "wizard":
      return await runWizard(runtime, json);
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
    case "init":
      return runInit(runtime, json);
    case "mcp":
      void runMcp(runtime);
      return 0;
  }
}

/** Create moeicons.config.json if absent (never overwrites an existing config). */
function runInit(runtime: CliRuntime, json: boolean): number {
  const cwd = runtime.cwd();
  const project = detectProject(cwd);
  if (!project) {
    throw new CliError("VALIDATION_ERROR", "no project found");
  }
  const existing = readMoeiconsConfig(project.root);
  if (existing.kind === "ok") {
    if (json) runtime.stdout(JSON.stringify({ ok: false, error: "config already exists" }));
    else runtime.stdout("moeicons.config.json already exists; not overwritten.\n");
    return 0;
  }
  const config = createMoeiconsConfig({ framework: "react" });
  const target = join(project.root, "moeicons.config.json");
  try {
    writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    runtime.stderr(`init failed: ${String(error)}\n`);
    return 1;
  }
  if (json) runtime.stdout(JSON.stringify({ ok: true, created: target }));
  else runtime.stdout(`Created ${target}\n`);
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
async function runWizard(runtime: CliRuntime, json: boolean): Promise<number> {
  renderBanner(runtime);
  if (json) {
    runtime.stdout(JSON.stringify({ ok: true, message: "interactive wizard unavailable in JSON mode; use install/login/account/groups/generate" }));
    return 0;
  }

  const tui = {
    streams: {
      isTTY: runtime.isTTY,
      write: runtime.stdout,
      readLine: runtime.readLine,
      readKey: runtime.readKey,
    },
  };

  let choice: string;
  try {
    choice = await select(tui, "Choose an option", {
      choices: [
        { value: "free", label: "Install moeicons free" },
        { value: "pro", label: "Install moeicons pro (API key)" },
        { value: "login", label: "Login" },
      ],
      canCancel: true,
    });
  } catch (error) {
    if (error instanceof CancelledError) return 0;
    throw error;
  }

  const project = detectProject(runtime.cwd());
  if (!project) {
    throw new CliError("VALIDATION_ERROR", "no package.json found in the current directory or parents; run inside a project");
  }
  const confirmed = await confirm(tui, `Install into ${project.root}?`, true);
  if (!confirmed) return 0;

  runtime.stdout(`Project root: ${project.root}\n`);
  if (choice === "free") {
    return runInstall("free", runtime, false);
  }
  runtime.stdout(`Flow "pro"/"login" requires backend endpoints (pending BE-02/BE-04).\n`);
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
  files["types.ts"] = `export type { ReactIconProps } from "moe-icons";\n`;
  files[`.moeicons-${groupId}.marker`] = `${groupId}\n`;

  const plan = createInstallPlan(join(project.root, "src", "moeicons"), files);
  const zip = createArtifactZip(files);

  // transactional write: stage sibling, verify, swap; config is updated last
  try {
    executeInstallPlan(plan, { mkdirSync, writeFileSync, existsSync, renameSync, rmSync });
  } catch (error) {
    if (json) {
      runtime.stdout(JSON.stringify({ ok: false, error: String(error) }));
    } else {
      runtime.stderr(`install failed: ${String(error)}\n`);
    }
    return 1;
  }

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
    runtime.stdout(`Installed to src/moeicons (group: ${groupId}).\n`);
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
  if (config.kind !== "ok") {
    if (json) {
      runtime.stdout(JSON.stringify({ ok: false, error: `config state: ${config.kind}` }));
    } else {
      runtime.stderr(`config state: ${config.kind}; run \`moeicons init\` or add moeicons.config.json\n`);
    }
    return 1;
  }

  const plan = planGeneratedFiles(config.config, config.config.outputDir);
  if (!plan.ok) {
    runtime.stderr(JSON.stringify({ ok: false, errors: plan.errors }) + "\n");
    return 1;
  }

  try {
    for (const file of plan.files) {
      const full = join(project.root, file.path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, file.content);
    }
  } catch (error) {
    if (json) runtime.stdout(JSON.stringify({ ok: false, error: String(error) }));
    else runtime.stderr(`generate failed: ${String(error)}\n`);
    return 1;
  }

  if (json) {
    runtime.stdout(JSON.stringify({ ok: true, generated: plan.files.map((f) => f.path) }));
  } else {
    runtime.stdout(`Generated ${plan.files.length} files under ${config.config.outputDir}/\n`);
  }
  return 0;
}
