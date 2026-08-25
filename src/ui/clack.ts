import * as p from "@clack/prompts";
import { CliError } from "../errors/index.js";
import type { CommandUi } from "../core/context.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CliError("CANCELLED", "cancelled");
}

/**
 * Clack adapter. Maps Clack's cancel symbol to `undefined` so core never sees
 * Clack types, ANSI, or `process.exit()`.
 */
export function createClackUi(options: { readonly yes: boolean }): CommandUi {
  return {
    async select(message, choices, signal) {
      throwIfAborted(signal);
      const value = await p.select({
        message,
        options: choices.map((choice) => ({ value: choice.value, label: choice.label })),
      });
      if (p.isCancel(value)) return undefined;
      return String(value);
    },
    async confirm(message, signal) {
      throwIfAborted(signal);
      if (options.yes) return true;
      const value = await p.confirm({ message });
      if (p.isCancel(value)) return undefined;
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
