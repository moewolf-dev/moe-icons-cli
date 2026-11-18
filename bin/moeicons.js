#!/usr/bin/env node
/**
 * P0-00 / REF-07: process wrapper.
 *
 * Owns the Node preflight and OS signals. No business module installs signal
 * handlers. First SIGINT/SIGTERM aborts active work and runs registered cleanup
 * (temporary downloads, cursor/raw mode); a second signal terminates immediately.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assertSupportedNode, startupFailureJson } = require("./check-node.cjs");

const args = process.argv.slice(2);
const jsonRequested = args.includes("--json");

// Test seam: the wrapper's preflight can be exercised on a supported runner
// without installing an unsupported Node. It is inert unless MOEICONS_TEST_MODE=1.
const reportedVersion =
  process.env.MOEICONS_TEST_MODE === "1" && process.env.MOEICONS_TEST_NODE_VERSION
    ? process.env.MOEICONS_TEST_NODE_VERSION
    : process.version;
const checked = assertSupportedNode(reportedVersion, { env: process.env });
if (!checked.ok) {
  if (jsonRequested) {
    process.stdout.write(`${JSON.stringify(startupFailureJson(checked))}\n`);
  } else {
    process.stderr.write(checked.message);
  }
  process.exit(1);
}

function emitStartupFailure(code, message, hint) {
  if (jsonRequested) {
    process.stdout.write(`${JSON.stringify({ ok: false, code, message, hint })}\n`);
  } else {
    process.stderr.write(`error [${code}] ${message}\nhint: ${hint}\n`);
  }
  process.exitCode = 1;
}

// Plain help/version do not need the generation, extraction or MCP modules.
if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
  try {
    const { HELP_TEXT } = await import("../dist/commands/parser.js");
    process.stdout.write(HELP_TEXT);
  } catch (error) {
    emitStartupFailure(
      "CLI_IMPORT_FAILED",
      `the CLI build could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      "reinstall moeicons; if you are developing, run `npm run build`",
    );
  }
} else if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
  try {
    process.stdout.write(require("../package.json").version + "\n");
  } catch (error) {
    emitStartupFailure(
      "PACKAGE_METADATA_MISSING",
      `package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
      "reinstall moeicons from npm",
    );
  }
} else {
  let main;
  try {
    ({ main } = await import("../dist/cli.js"));
  } catch (error) {
    emitStartupFailure(
      "CLI_IMPORT_FAILED",
      `the CLI build could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      "reinstall moeicons; if you are developing, run `npm run build`",
    );
    process.exit(1);
  }

  const controller = new AbortController();
  const cleanups = [];
  let signalReceived = undefined;

  const runCleanups = async () => {
    for (const cleanup of cleanups.splice(0)) {
      try {
        await cleanup();
      } catch {
        /* Cleanup failures must not change the business result. */
      }
    }
  };

  const handleSignal = (signal) => {
    if (signalReceived !== undefined) {
      // Second signal: the user asked for immediate termination.
      process.exit(signal === "SIGTERM" ? 143 : 130);
    }
    signalReceived = signal;
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
    const force = setTimeout(() => process.exit(signal === "SIGTERM" ? 143 : 130), 2_000);
    force.unref?.();
    void runCleanups().finally(() => {
      process.exitCode = signal === "SIGTERM" ? 143 : 130;
    });
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  const runtime = {
    cwd: () => process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdinTTY: () => Boolean(process.stdin.isTTY),
    stdoutTTY: () => Boolean(process.stdout.isTTY),
    stderrTTY: () => Boolean(process.stderr.isTTY),
    columns: () => process.stdout.columns,
    rows: () => process.stdout.rows,
    signal: controller.signal,
    onCleanup: (cleanup) => cleanups.push(cleanup),
    // Canonical readline consumes Ctrl+C in --accessible mode; forward it to the
    // same bounded shutdown path as an OS signal.
    onInterrupt: () => handleSignal("SIGINT"),
  };

  try {
    const code = await main(args, runtime);
    await runCleanups();
    if (signalReceived === undefined) process.exitCode = code;
  } catch (error) {
    await runCleanups();
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error [UNEXPECTED] ${message}\n`);
    process.stderr.write(
      "hint: run `moeicons doctor --export-diagnostics` and inspect the local bundle\n",
    );
    if (signalReceived === undefined) process.exitCode = 5;
  }
}
