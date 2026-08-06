import { CliError } from "../errors/index.js";

export type Command =
  | { readonly name: "install"; readonly group?: string }
  | { readonly name: "login" }
  | { readonly name: "logout" }
  | { readonly name: "account" }
  | { readonly name: "groups" }
  | { readonly name: "generate" }
  | { readonly name: "init" }
  | { readonly name: "mcp" }
  | { readonly name: "help" }
  | { readonly name: "version" }
  | { readonly name: "wizard" };

export interface ParseResult {
  readonly command: Command;
  /** Non-interactive/JSON mode flag. */
  readonly json: boolean;
  /** --yes: skip confirmations in noninteractive mode. */
  readonly yes: boolean;
}

/**
 * Parse argv into a Command. Unknown options/commands are validation errors.
 * `moeicons --pro` / `--ent` / `--license-key` legacy aliases map to install
 * for the compatibility window (CLI-18).
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const json = argv.includes("--json");
  const yes = argv.includes("--yes");

  const positional = argv.filter((a) => !a.startsWith("-"));

  if (argv.includes("--version") || argv.includes("-v")) {
    return { command: { name: "version" }, json, yes };
  }
  if (argv.includes("--help") || argv.includes("-h") || positional.length === 0) {
    return { command: { name: positional.includes("help") ? "help" : "wizard" }, json, yes };
  }

  const name = positional[0];
  if (!name) {
    throw new CliError("VALIDATION_ERROR", "no command provided");
  }

  switch (name) {
    case "install":
      return { command: positional[1] ? { name: "install", group: positional[1] } : { name: "install" }, json, yes };
    case "login":
      return { command: { name: "login" }, json, yes };
    case "logout":
      return { command: { name: "logout" }, json, yes };
    case "account":
      return { command: { name: "account" }, json, yes };
    case "groups":
      return { command: { name: "groups" }, json, yes };
    case "generate":
      return { command: { name: "generate" }, json, yes };
    case "init":
      return { command: { name: "init" }, json, yes };
    case "mcp":
      return { command: { name: "mcp" }, json, yes };
    case "help":
      return { command: { name: "help" }, json, yes };
    // legacy compatibility aliases (migration window)
    case "--pro":
    case "--ent":
      return { command: { name: "install", group: name.slice(2) }, json, yes };
    default:
      throw new CliError("VALIDATION_ERROR", `unknown command: ${name}`);
  }
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
  moeicons init                 create moeicons.config.json
  moeicons mcp                  start the MCP stdio server
  moeicons --version            show version
  moeicons --help               show help

Options:
  --json    machine-readable JSON output
  --yes     skip confirmations in noninteractive mode
`;
