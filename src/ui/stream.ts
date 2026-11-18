import {
  confirm as promptConfirm,
  select as promptSelect,
  CancelledError,
} from "../tui/primitives.js";
import { CliError } from "../errors/index.js";
import {
  PROMPT_ABORT,
  PROMPT_CANCEL,
  submitted,
  type PromptResult,
} from "../core/prompt-result.js";
import { renderProgressBar, renderTaskStatus } from "../tui/components.js";
import { createTheme } from "./theme.js";
import type { CommandUi, ProgressBarEvent, TaskHandle, UiChoice } from "../core/context.js";
import type { TerminalCapabilities } from "./capabilities.js";

export interface StreamUiRuntime {
  readonly isTTY: () => boolean;
  readonly stdout: (text: string) => void;
  readonly readLine: (prompt: string) => Promise<string>;
  readonly readKey: () => Promise<string>;
}

/** Injected-stream adapter used by tests. Production TTY uses the Clack adapter. */
export function createStreamUi(
  runtime: StreamUiRuntime,
  options: { readonly yes: boolean; readonly capabilities?: TerminalCapabilities },
): CommandUi {
  const deps = {
    streams: {
      isTTY: runtime.isTTY,
      write: runtime.stdout,
      readLine: runtime.readLine,
      readKey: runtime.readKey,
    },
    yes: options.yes,
  };

  async function askSelect(
    message: string,
    choices: readonly UiChoice[],
    signal: AbortSignal,
  ): Promise<PromptResult<string>> {
    try {
      const value = await promptSelect({ ...deps, signal }, message, { choices, canCancel: true });
      return submitted(value);
    } catch (error) {
      if (error instanceof CancelledError) return signal.aborted ? PROMPT_ABORT : PROMPT_CANCEL;
      throw error;
    }
  }

  async function askConfirm(message: string, signal: AbortSignal): Promise<PromptResult<boolean>> {
    try {
      return submitted(await promptConfirm({ ...deps, signal }, message, true));
    } catch (error) {
      if (error instanceof CancelledError) return signal.aborted ? PROMPT_ABORT : PROMPT_CANCEL;
      throw error;
    }
  }

  return {
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    promptSelect: askSelect,
    async select(message, choices, signal) {
      const result = await askSelect(message, choices, signal);
      return result.kind === "submit" ? result.value : undefined;
    },
    promptConfirm: askConfirm,
    async confirm(message, signal) {
      const result = await askConfirm(message, signal);
      return result.kind === "submit" ? result.value : undefined;
    },
    async promptText(message, signal) {
      if (signal.aborted) return PROMPT_ABORT;
      if (!runtime.isTTY()) throw new CliError("NOT_TTY", "text input requires a TTY");
      return submitted(await runtime.readLine(`${message} `));
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
      return {
        update(next) {
          runtime.stdout(`${next}\n`);
        },
        stop() {
          return undefined;
        },
      };
    },
    // W3-A: injected-stream adapter logs one deterministic line per tick (no
    // ANSI, no carriage returns) so tests assert exact progress output.
    progressBar(label) {
      const theme = createTheme(false);
      let latest: ProgressBarEvent = {};
      return {
        update(event) {
          latest = { ...latest, ...(event ?? {}) };
          runtime.stdout(
            `${renderProgressBar({
              label: latest.label ?? label,
              theme,
              ...(latest.done !== undefined ? { done: latest.done } : {}),
              ...(latest.total !== undefined ? { total: latest.total } : {}),
              ...(latest.detail !== undefined ? { detail: latest.detail } : {}),
            })}\n`,
          );
        },
        stop(message) {
          if (message) runtime.stdout(`${message}\n`);
        },
      };
    },
    task(label): TaskHandle {
      const theme = createTheme(false);
      return {
        succeed(message) {
          runtime.stdout(
            `${renderTaskStatus({ state: "success", label, ...(message ? { detail: message } : {}), theme })}\n`,
          );
        },
        fail(message) {
          runtime.stdout(
            `${renderTaskStatus({ state: "failure", label, ...(message ? { detail: message } : {}), theme })}\n`,
          );
        },
        timeout(message) {
          runtime.stdout(
            `${renderTaskStatus({ state: "timeout", label, ...(message ? { detail: message } : {}), theme })}\n`,
          );
        },
      };
    },
  };
}
