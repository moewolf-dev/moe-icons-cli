#!/usr/bin/env node
import { main } from "../dist/cli.js";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

const runtime = {
  cwd: () => process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readLine: (prompt) =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    }),
  readKey: () =>
    new Promise((resolve) => {
      const onData = (chunk) => {
        process.stdin.off("data", onData);
        resolve(String(chunk));
      };
      process.stdin.once("data", onData);
    }),
};

main(process.argv.slice(2), runtime).then(
  (code) => {
    rl.close();
    process.exitCode = code;
  },
  (error) => {
    rl.close();
    process.stderr.write(`fatal: ${String(error)}\n`);
    process.exitCode = 5;
  },
);
