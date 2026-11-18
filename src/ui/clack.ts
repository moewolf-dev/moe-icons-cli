import * as p from "@clack/prompts";
import { isCancel } from "@clack/core";
import { CliError } from "../errors/index.js";
import {
  PROMPT_ABORT,
  PROMPT_CANCEL,
  submitted,
  type PromptResult,
} from "../core/prompt-result.js";
import type {
  CommandUi,
  ProgressBarEvent,
  ProgressBarHandle,
  TaskHandle,
  UiChoice,
} from "../core/context.js";
import { brandedConfirm, brandedSelect, brandedText } from "./branded-prompts.js";
import { renderProgressBar, renderTaskStatus } from "../tui/components.js";
import { createThrottledPainter, createTerminalDimensions } from "./terminal.js";
import type { TerminalCapabilities } from "./capabilities.js";
import type { UiTheme } from "./theme.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CliError("CANCELLED", "cancelled");
}

export interface ClackUiOptions {
  readonly yes: boolean;
  readonly theme: UiTheme;
  readonly capabilities?: TerminalCapabilities;
}

/**
 * Clack reports Esc and Ctrl+C with the same cancel symbol. We do not pretend
 * they are different: both are a prompt cancel for the current step, unless the
 * caller's AbortSignal fired (external abort) or the raw Ctrl+C byte was
 * observed, which is a hard task abort. This is the P1-04 contract.
 */
function watchCtrlC(): { readonly saw: () => boolean; readonly dispose: () => void } {
  let sawCtrlC = false;
  const stream = process.stdin as NodeJS.ReadStream & {
    on?: (event: string, listener: (chunk: Buffer) => void) => unknown;
    removeListener?: (event: string, listener: (chunk: Buffer) => void) => unknown;
  };
  const listener = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("binary");
    if (text.includes("\u0003")) sawCtrlC = true;
  };
  try {
    stream?.on?.("data", listener);
  } catch {
    /* No stdin in this environment. */
  }
  return {
    saw: () => sawCtrlC,
    dispose() {
      try {
        stream?.removeListener?.("data", listener);
      } catch {
        /* ignore */
      }
    },
  };
}

async function runPrompt<T>(
  signal: AbortSignal,
  prompt: () => Promise<T | symbol>,
): Promise<PromptResult<T>> {
  throwIfAborted(signal);
  const ctrlC = watchCtrlC();
  try {
    const value = await prompt();
    if (isCancel(value)) {
      return signal.aborted || ctrlC.saw() ? PROMPT_ABORT : PROMPT_CANCEL;
    }
    return submitted(value as T);
  } finally {
    ctrlC.dispose();
  }
}

/**
 * Clack adapter. Maps Clack's cancel symbol to a PromptResult so core never sees
 * Clack types, ANSI, or `process.exit()`. The legacy `select`/`confirm` members
 * remain for callers that only need a value.
 */
export function createClackUi(options: ClackUiOptions): CommandUi {
  const dimensions = createTerminalDimensions({
    columns: () => process.stdout?.columns,
    rows: () => process.stdout?.rows,
    stdout: process.stdout,
  });

  const askSelect = (message: string, choices: readonly UiChoice[], signal: AbortSignal) =>
    runPrompt(signal, () => brandedSelect({ message, choices, signal, theme: options.theme }));

  const askConfirm = (message: string, signal: AbortSignal) => {
    if (options.yes) return Promise.resolve(submitted(true));
    return runPrompt(signal, () => brandedConfirm({ message, signal, theme: options.theme }));
  };

  return {
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    async promptSelect(message, choices, signal) {
      return askSelect(message, choices, signal);
    },
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
      return runPrompt(signal, () => brandedText({ message, signal, theme: options.theme }));
    },
    async text(message, signal) {
      const result = await runPrompt(signal, () =>
        brandedText({ message, signal, theme: options.theme }),
      );
      return result.kind === "submit" ? result.value : undefined;
    },
    note(message) {
      p.note(message);
    },
    progress(message) {
      const spinner = p.spinner();
      spinner.start(message);
      return {
        update(next) {
          spinner.message(next);
        },
        stop(done) {
          spinner.stop(done ?? message);
        },
      };
    },
    // W3-A: clack has no bar primitive, so the bar is rendered as the spinner
    // message. Unknown totals degrade to a byte counter (never a fake percent).
    progressBar(label, signal): ProgressBarHandle {
      throwIfAborted(signal);
      const spinner = p.spinner();
      spinner.start(label);
      const startedAt = Date.now();
      let latest: ProgressBarEvent = {};
      const paint = () => {
        spinner.message(
          renderProgressBar({
            label: latest.label ?? label,
            theme: options.theme,
            columns: dimensions.columns(),
            elapsedMs: Date.now() - startedAt,
            ...(latest.done !== undefined ? { done: latest.done } : {}),
            ...(latest.total !== undefined ? { total: latest.total } : {}),
            ...(latest.detail !== undefined ? { detail: latest.detail } : {}),
          }),
        );
      };
      // Coalesce byte ticks so a fast download cannot flood the terminal or
      // steal keyboard responsiveness; flush the final value once on stop.
      const painter = createThrottledPainter<ProgressBarEvent>(() => paint(), { intervalMs: 80 });
      const unsubscribe = dimensions.onResize(() => painter.update(latest));
      return {
        update(event) {
          latest = { ...latest, ...(event ?? {}) };
          painter.update(latest);
        },
        stop(done) {
          painter.flush();
          painter.dispose();
          unsubscribe();
          spinner.stop(done ?? renderTaskStatus({ state: "success", label, theme: options.theme }));
        },
      };
    },
    // W3-C: strict task lifecycle for work without a progress bar.
    task(label, signal): TaskHandle {
      throwIfAborted(signal);
      const spinner = p.spinner();
      spinner.start(`${options.theme.dim("…")} ${label}`);
      const finish = (state: "success" | "failure" | "timeout", message?: string) => {
        spinner.stop(
          renderTaskStatus({
            state,
            label,
            ...(message ? { detail: message } : {}),
            theme: options.theme,
          }),
        );
      };
      return {
        succeed(message) {
          finish("success", message);
        },
        fail(message) {
          finish("failure", message);
        },
        timeout(message) {
          finish("timeout", message);
        },
      };
    },
    dispose() {
      dimensions.dispose();
    },
  };
}
