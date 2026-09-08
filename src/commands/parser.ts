import { Command as Commander, CommanderError } from "commander";
import { CliError } from "../errors/index.js";

export type Command =
  | { readonly name: "install"; readonly group?: string; readonly target?: Target }
  | { readonly name: "login" }
  | { readonly name: "logout" }
  | { readonly name: "account" }
  | { readonly name: "groups" }
  | { readonly name: "generate" }
  | { readonly name: "init"; readonly dryRun?: boolean }
  | { readonly name: "doctor"; readonly check?: boolean; readonly dryRun?: boolean }
  | { readonly name: "mcp" }
  | { readonly name: "update"; readonly metadata?: boolean }
  | { readonly name: "help" }
  | { readonly name: "version" }
  | { readonly name: "wizard" };

export interface ParseResult {
  readonly command: Command;
  /** Non-interactive/JSON mode flag. */
  readonly json: boolean;
  readonly yes: boolean;
  /** Skip Tailwind config auto-integration (H4). */
  readonly noTailwind: boolean;
  readonly target?: Target;
}

export type Target = "react" | "vue" | "vanilla" | "assets";

const SIMPLE_COMMANDS = [
  "login",
  "logout",
  "account",
  "groups",
  "generate",
  "mcp",
  "help",
] as const;

/**
 * Options accepted on every command. `--dry-run`/`--check` are additionally
 * accepted on `init` / `doctor` (validated in parseArgs). Unknown options never
 * pass silently; they produce a stable VALIDATION_ERROR.
 */
const GLOBAL_OPTIONS = new Set([
  "--json",
  "--yes",
  "--no-tailwind",
  "--pro",
  "--ent",
  "--help",
  "-h",
  "--version",
  "-v",
  "--showVersion",
]);

function commandName(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/** Validate that no option is unknown for the given command. */
function rejectUnknownOptions(argv: readonly string[], command?: string): void {
  const allowLocal = command === "init" || command === "doctor";
  const local = new Set<string>(["--dry-run", "--check"]);
  for (const arg of argv) {
    if (!arg.startsWith("-")) continue;
    const name = arg.split("=")[0] ?? arg;
    if (arg.startsWith("--target")) continue; // value validated separately
    if (GLOBAL_OPTIONS.has(name)) continue;
    if (allowLocal && local.has(name)) continue;
    throw new CliError("VALIDATION_ERROR", `unknown option: ${name}`);
  }}

function parseTarget(argv: readonly string[]): Target | undefined {
  const targetIndex = argv.indexOf("--target");
  const targetValue = targetIndex >= 0 ? argv[targetIndex + 1] : undefined;
  if (targetIndex >= 0 && !["react", "vue", "vanilla", "assets"].includes(targetValue ?? "")) {
    throw new CliError("VALIDATION_ERROR", `unknown target: ${targetValue ?? ""}`);
  }
  return targetValue as Target | undefined;
}

function addSharedOptions(command: Commander): Commander {
  return command
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .option("-h, --help")
    .option("-v, --showVersion")
    .option("--version")
    .option("--json")
    .option("--yes")
    .option("--no-tailwind")
    .option("--pro")
    .option("--ent");
}

const KNOWN_COMMANDS = new Set<string>(["install", "update", "init", "doctor", ...SIMPLE_COMMANDS]);

/**
 * Parse argv into a Command. Never calls `process.exit()`.
 * `moeicons --pro` / `--ent` legacy aliases map to install for the compatibility window.
 * Unknown commands and unknown options map to a stable VALIDATION_ERROR.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const json = argv.includes("--json");
  const yes = argv.includes("--yes");
  const noTailwind = argv.includes("--no-tailwind");
  const version = argv.includes("--version") || argv.includes("-v");
  const help = argv.includes("--help") || argv.includes("-h");
  const pro = argv.includes("--pro");
  const ent = argv.includes("--ent");
  const target = parseTarget(argv);

  const first = commandName(argv);
  if (first !== undefined && !KNOWN_COMMANDS.has(first)) {
    rejectUnknownOptions(argv, first);
    throw new CliError("VALIDATION_ERROR", `unknown command: ${first}`);
  }
  if (first === "init" || first === "doctor") {
    rejectUnknownOptions(argv, first);
  } else {
    rejectUnknownOptions(argv);
  }

  const withTarget = <T extends Command>(command: T): T =>
    target ? { ...command, target } : command;

  // Preserve previous flag precedence: version/help/legacy aliases beat subcommands.
  if (version)
    return { command: { name: "version" }, json, yes, noTailwind, ...(target ? { target } : {}) };
  if (help)
    return { command: { name: "help" }, json, yes, noTailwind, ...(target ? { target } : {}) };
  if (pro)
    return {
      command: withTarget({ name: "install", group: "pro" }),
      json,
      yes,
      noTailwind,
      ...(target ? { target } : {}),
    };
  if (ent)
    return {
      command: withTarget({ name: "install", group: "ent" }),
      json,
      yes,
      noTailwind,
      ...(target ? { target } : {}),
    };

  if (first === "init") {
    return {
      command: withTarget({ name: "init", ...(argv.includes("--dry-run") ? { dryRun: true } : {}) }),
      json,
      yes,
      noTailwind,
      ...(target ? { target } : {}),
    };
  }
  if (first === "doctor") {
    return {
      command: {
        name: "doctor",
        ...(argv.includes("--check") ? { check: true } : {}),
        ...(argv.includes("--dry-run") ? { dryRun: true } : {}),
      },
      json,
      yes,
      noTailwind,
      ...(target ? { target } : {}),
    };
  }

  let selected: Command | undefined;
  try {
    createProgram((command) => {
      selected = withTarget(command);
    }).parse(argv, { from: "user" });
  } catch (error) {
    toCliError(error);
  }

  return {
    command: selected ?? { name: "wizard" },
    json,
    yes,
    noTailwind,
    ...(target ? { target } : {}),
  };
}

function createProgram(onSelect: (command: Command) => void): Commander {
  const program = addSharedOptions(new Commander());
  program
    .name("moeicons")
    .exitOverride()
    .addHelpCommand(false)
    .showHelpAfterError(false)
    .enablePositionalOptions()
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    })
    .action(() => {
      onSelect({ name: "wizard" });
    });

  addSharedOptions(program.command("install").argument("[group]")).action((group?: string) => {
    onSelect(group ? { name: "install", group } : { name: "install" });
  });
  addSharedOptions(program.command("update").argument("[sub]")).action((sub?: string) => {
    onSelect({ name: "update", metadata: sub === "metadata" });
  });
  for (const name of SIMPLE_COMMANDS) {
    addSharedOptions(program.command(name)).action(() => {
      onSelect({ name });
    });
  }
  return program;
}

function toCliError(error: unknown): never {
  if (error instanceof CommanderError && error.code === "commander.unknownCommand") {
    const match = /unknown command ['`]?([^'`\s]+)/.exec(error.message);
    throw new CliError("VALIDATION_ERROR", `unknown command: ${match?.[1] ?? "unknown"}`);
  }
  if (error instanceof CommanderError && error.code === "commander.unknownOption") {
    const match = /unknown option ['`]?([^'`\s]+)/.exec(error.message);
    throw new CliError("VALIDATION_ERROR", `unknown option: ${match?.[1] ?? "unknown"}`);
  }
  if (
    error instanceof CommanderError &&
    (error.code === "commander.help" || error.code === "commander.helpDisplayed")
  ) {
    throw new CliError("VALIDATION_ERROR", error.message);
  }
  throw error;
}

export const HELP_TEXT = `moeicons — Moeicons icon library CLI

Usage:
  moeicons                      interactive guided flow (free / pro / login)
  moeicons install [group]      install an icon group
  moeicons login                browser login (PKCE)
  moeicons logout               clear local session
  moeicons account              show account/tier info
  moeicons groups               list available icon groups
  moeicons generate             generate React/Vue proxy components
  moeicons init                 create moeicons.config.jsonc
  moeicons init --dry-run       print the full config/entry/style plan without writing
  moeicons doctor               diagnose project anchors (read-only)
  moeicons doctor --check       exit non-zero when any required anchor is not OK
  moeicons update metadata      sync MANUAL.md/catalog.json/manifest.json only
  moeicons update               full code + metadata update
  moeicons mcp                  start the MCP stdio server
  moeicons --version            show version
  moeicons --help               show help

Options:
  --json         machine-readable JSON output
  --yes          skip confirmations in noninteractive mode
  --target       output target: react, vue, vanilla, or assets
  --no-tailwind  skip Tailwind config auto-integration
  --dry-run      (init/doctor) plan only, never write
  --check        (doctor) exit 1 when required anchors are not OK
`;
