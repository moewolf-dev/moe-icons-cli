import type { CommandUi } from "../core/context.js";
import { createAccessibleUi, createReadlineUiRuntime } from "./accessible.js";
import { createClackUi } from "./clack.js";
import { createNonInteractiveUi } from "./non-interactive.js";
import { createStreamUi, type StreamUiRuntime } from "./stream.js";
import { createTheme } from "./theme.js";
import { detectCapabilities, type TerminalCapabilities } from "./capabilities.js";

export interface CreateUiOptions {
  readonly json: boolean;
  readonly yes: boolean;
  /** Historical combined TTY flag (stdin && stdout). Kept for compatibility. */
  readonly isTTY: boolean;
  /** REF-02: separately measured streams. Default to `isTTY` when absent. */
  readonly stdinTTY?: boolean;
  readonly stdoutTTY?: boolean;
  readonly stderrTTY?: boolean;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  /** Explicit `--accessible`/`MOEICONS_ACCESSIBLE`. */
  readonly accessible?: boolean;
  readonly color?: boolean;
  readonly unicode?: boolean;
  /** Present in tests (and optional in production). When set, skip Clack so prompts are injectable. */
  readonly streams?: StreamUiRuntime;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** REF-07: wrapper-owned interrupt hook (Ctrl+C in canonical readline). */
  readonly onInterrupt?: () => void;
}

function capabilitiesOf(options: Omit<CreateUiOptions, "streams">): TerminalCapabilities {
  return detectCapabilities({
    env: options.env,
    json: options.json,
    yes: options.yes,
    stdinTTY: options.stdinTTY ?? options.isTTY,
    stdoutTTY: options.stdoutTTY ?? options.isTTY,
    stderrTTY: options.stderrTTY ?? options.isTTY,
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    ...(options.rows !== undefined ? { rows: options.rows } : {}),
    ...(options.accessible !== undefined ? { accessible: options.accessible } : {}),
    ...(options.color !== undefined ? { color: options.color } : {}),
    ...(options.unicode !== undefined ? { unicode: options.unicode } : {}),
  });
}

/**
 * Pick a UI adapter from measured capabilities, never from `--json` alone.
 *
 * - JSON / non-interactive input: a non-prompting, zero-rendering adapter.
 * - Injected streams (tests): deterministic line/label adapter.
 * - Explicit accessible mode: static numbered readline input, no animation.
 * - Real TTY: Clack with a shared cancel/abort contract.
 */
export function createCommandUi(options: CreateUiOptions): CommandUi {
  const capabilities = capabilitiesOf(options);
  if (options.json || !capabilities.interactiveInput) {
    return createNonInteractiveUi({ yes: options.yes, capabilities });
  }
  if (options.streams?.readLine) {
    return createStreamUi(options.streams, { yes: options.yes, capabilities });
  }
  if (capabilities.accessible) {
    const runtime = createReadlineUiRuntime({
      ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
    });
    const ui = createAccessibleUi(runtime, { yes: options.yes, capabilities });
    return { ...ui, dispose: () => runtime.close() };
  }
  return createClackUi({
    yes: options.yes,
    theme: createTheme(capabilities.color),
    capabilities,
  });
}

/** Test/embedding helper: expose the capability snapshot without constructing UI. */
export function uiCapabilities(options: Omit<CreateUiOptions, "streams">): TerminalCapabilities {
  return capabilitiesOf(options);
}
