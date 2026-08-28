import type { CommandUi } from "../core/context.js";
import { createClackUi } from "./clack.js";
import { createNonInteractiveUi } from "./non-interactive.js";
import { createStreamUi, type StreamUiRuntime } from "./stream.js";
import { createTheme, isThemeEnabled } from "./theme.js";

export interface CreateUiOptions {
  readonly json: boolean;
  readonly yes: boolean;
  readonly isTTY: boolean;
  /** Present in tests (and optional in production). When set, skip Clack so prompts are injectable. */
  readonly streams?: StreamUiRuntime;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Pick a UI adapter. `--json` and non-TTY never render Clack/banner-capable prompts.
 * TTY with injected streams uses the stream adapter; real TTY uses Clack.
 */
export function createCommandUi(options: CreateUiOptions): CommandUi {
  if (options.json || !options.isTTY) {
    return createNonInteractiveUi({ yes: options.yes });
  }
  if (options.streams?.readLine) {
    return createStreamUi(options.streams, { yes: options.yes });
  }
  return createClackUi({
    yes: options.yes,
    theme: createTheme(isThemeEnabled(options.env, options.isTTY)),
  });
}
