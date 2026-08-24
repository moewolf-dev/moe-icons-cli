import { CliError } from "../errors/index.js";
import type { CommandUi } from "../core/context.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CliError("CANCELLED", "cancelled");
}

/** JSON / non-TTY adapter: never prompts, never writes ANSI, never uses default-yes to continue. */
export function createNonInteractiveUi(options: { readonly yes: boolean }): CommandUi {
  return {
    select(_message, _choices, signal) {
      throwIfAborted(signal);
      return Promise.reject(new CliError("NOT_TTY", "interactive selection requires a TTY; use a specific command or --json"));
    },
    confirm(_message, signal) {
      throwIfAborted(signal);
      if (options.yes) return Promise.resolve(true);
      return Promise.reject(new CliError("NOT_TTY", "confirmation requires a TTY; pass --yes to skip"));
    },
    text(_message, signal) {
      throwIfAborted(signal);
      return Promise.reject(new CliError("NOT_TTY", "text input requires a TTY"));
    },
    note() {
      return undefined;
    },
    progress() {
      return { stop() { return undefined; } };
    },
  };
}
