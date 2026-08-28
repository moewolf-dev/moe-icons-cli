#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assertSupportedNode } = require("./check-node.cjs");
const checked = assertSupportedNode(process.version);
if (!checked.ok) {
  process.stderr.write(checked.message);
  process.exit(1);
}

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
