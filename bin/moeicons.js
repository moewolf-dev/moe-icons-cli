#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assertSupportedNode } = require("./check-node.cjs");
const checked = assertSupportedNode(process.version);
if (!checked.ok) {
  process.stderr.write(checked.message);
  process.exit(1);
}

// Plain help/version do not need the generation, extraction or MCP modules.
const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
  const { HELP_TEXT } = await import("../dist/commands/parser.js");
  process.stdout.write(HELP_TEXT);
} else if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
  process.stdout.write(require("../package.json").version + "\n");
} else {
const { main } = await import("../dist/cli.js");

const runtime = {
  cwd: () => process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  columns: () => process.stdout.columns,
};

main(process.argv.slice(2), runtime).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`fatal: ${String(error)}\n`);
    process.exitCode = 5;
  },
);

}
