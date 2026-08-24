import { confirm as promptConfirm, select as promptSelect, CancelledError } from "../tui/primitives.js";
import { CliError } from "../errors/index.js";
import type { CommandUi } from "../core/context.js";

export interface StreamUiRuntime {
  readonly isTTY: () => boolean;
  readonly stdout: (text: string) => void;
  readonly readLine: (prompt: string) => Promise<string>;
  readonly readKey: () => Promise<string>;
}

/** Injected-stream adapter used by tests. Production TTY uses the Clack adapter. */
export function createStreamUi(runtime: StreamUiRuntime, options: { readonly yes: boolean }): CommandUi {
  const deps = {
    streams: {
      isTTY: runtime.isTTY,
      write: runtime.stdout,
      readLine: runtime.readLine,
      readKey: runtime.readKey,
    },
    yes: options.yes,
  };
  return {
    async select(message, choices, signal) {
      try {
        return await promptSelect({ ...deps, signal }, message, { choices, canCancel: true });
      } catch (error) {
        if (error instanceof CancelledError) return undefined;
        throw error;
      }
    },
    async confirm(message, signal) {
      try {
        return await promptConfirm({ ...deps, signal }, message, true);
      } catch (error) {
        if (error instanceof CancelledError) return undefined;
        throw error;
      }
    },
    async text(message, signal) {
      if (signal.aborted) throw new CliError("CANCELLED", "cancelled");
      if (!runtime.isTTY()) throw new CliError("NOT_TTY", "text input requires a TTY");
      return runtime.readLine(`${message} `);
    },
    note(message) {
      runtime.stdout(`${message}\n`);
    },
    progress(message) {
      runtime.stdout(`${message}\n`);
      return { stop() { return undefined; } };
    },
  };
}
