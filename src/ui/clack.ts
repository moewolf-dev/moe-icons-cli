import * as p from "@clack/prompts";
import { isCancel } from "@clack/core";
import { CliError } from "../errors/index.js";
import type { CommandUi } from "../core/context.js";
import { brandedConfirm, brandedSelect } from "./branded-prompts.js";
import type { UiTheme } from "./theme.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CliError("CANCELLED", "cancelled");
}

export interface ClackUiOptions {
  readonly yes: boolean;
  readonly theme: UiTheme;
}

/**
 * Clack adapter. Maps Clack's cancel symbol to `undefined` so core never sees
 * Clack types, ANSI, or `process.exit()`.
 */
export function createClackUi(options: ClackUiOptions): CommandUi {
  return {
    async select(message, choices, signal) {
      throwIfAborted(signal);
      const value = await brandedSelect({
        message,
        choices,
        signal,
        theme: options.theme,
      });
      if (isCancel(value)) return undefined;
      return String(value);
    },
    async confirm(message, signal) {
      throwIfAborted(signal);
      if (options.yes) return true;
      const value = await brandedConfirm({
        message,
        signal,
        theme: options.theme,
      });
      if (isCancel(value)) return undefined;
      return value;
    },
    async text(message, signal) {
      throwIfAborted(signal);
      const value = await p.text({ message });
      if (p.isCancel(value)) return undefined;
      return value;
    },
    note(message) {
      p.note(message);
    },
    progress(message) {
      const spinner = p.spinner();
      spinner.start(message);
      return {
        update(next) { spinner.message(next); },
        stop(done) {
          spinner.stop(done ?? message);
        },
      };
    },
  };
}
