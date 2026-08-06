#!/usr/bin/env node
import { main } from "../dist/cli.js";

const runtime = {
  cwd: () => process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
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
