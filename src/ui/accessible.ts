/**
 * REF-02 / P0-00: a static, accessible adapter.
 *
 * It uses plain numbered line input (no raw mode, no arrow keys, no spinner
 * animation), validates multi-digit numbers and works with a screen reader.
 * `NO_COLOR`/`TERM=dumb` and no-Unicode terminals get plain ASCII labels. It is
 * only selected explicitly (`--accessible`, `MOEICONS_ACCESSIBLE=1`, or a
 * detected accessibility preference) — a non-TTY is still a machine mode and
 * must receive actionable parameter guidance instead of a prompt.
 */

import { createInterface } from "node:readline/promises";
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
import type { TerminalCapabilities } from "./capabilities.js";
import { createTheme } from "./theme.js";
import { renderProgressBar, renderTaskStatus } from "../tui/components.js";

export interface AccessibleUiRuntime {
  readonly write: (text: string) => void;
  readonly readLine: (prompt: string) => Promise<string>;
  readonly isTTY: () => boolean;
  /** True once stdin hit EOF/closed; used to avoid an infinite empty-read loop. */
  readonly eof?: () => boolean;
}

export interface AccessibleUiOptions {
  readonly yes?: boolean;
  readonly capabilities?: TerminalCapabilities;
}

const CANCEL_WORDS = new Set(["0", "c", "cancel", "q", "quit", "esc", "escape"]);

function isAbort(signal: AbortSignal, runtime: AccessibleUiRuntime): boolean {
  return signal.aborted || runtime.eof?.() === true;
}

function promptResultForExit<T>(
  signal: AbortSignal,
  runtime: AccessibleUiRuntime,
): PromptResult<T> {
  return isAbort(signal, runtime) ? PROMPT_ABORT : PROMPT_CANCEL;
}

export function createAccessibleUi(
  runtime: AccessibleUiRuntime,
  options: AccessibleUiOptions = {},
): CommandUi {
  const capabilities = options.capabilities;
  const theme = createTheme(capabilities?.color ?? false);

  async function read(signal: AbortSignal, prompt: string): Promise<string | undefined> {
    if (signal.aborted) return undefined;
    try {
      return await runtime.readLine(prompt);
    } catch {
      return undefined;
    }
  }

  async function askSelect(
    message: string,
    choices: readonly UiChoice[],
    signal: AbortSignal,
  ): Promise<PromptResult<string>> {
    if (!runtime.isTTY()) {
      throw new CliError(
        "NOT_TTY",
        "interactive selection requires a TTY; use a specific command, --json or --yes",
      );
    }
    const lines = [message];
    choices.forEach((choice, index) => {
      if (choice.separatorBefore) lines.push("");
      lines.push(`  ${index + 1}. ${choice.label}`);
    });
    lines.push("  0. Cancel");
    runtime.write(`${lines.join("\n")}\n`);
    for (;;) {
      const line = await read(signal, `Select 1-${choices.length} (0 cancel): `);
      if (line === undefined) return promptResultForExit(signal, runtime);
      const value = line.trim().toLowerCase();
      if (signal.aborted) return PROMPT_ABORT;
      if (CANCEL_WORDS.has(value)) return PROMPT_CANCEL;
      if (!/^\d+$/.test(value)) {
        runtime.write("Invalid choice. Enter a number, or 0 to cancel.\n");
        continue;
      }
      const choice = choices[Number(value) - 1];
      if (choice) return submitted(choice.value);
      runtime.write("Invalid choice. Enter a number from the list.\n");
    }
  }

  async function askConfirm(message: string, signal: AbortSignal): Promise<PromptResult<boolean>> {
    if (options.yes) return submitted(true);
    if (!runtime.isTTY()) {
      throw new CliError("NOT_TTY", "confirmation requires a TTY; pass --yes to skip");
    }
    for (;;) {
      const line = await read(signal, `${message} [Y/n]: `);
      if (line === undefined) return promptResultForExit(signal, runtime);
      const value = line.trim().toLowerCase();
      if (signal.aborted) return PROMPT_ABORT;
      if (CANCEL_WORDS.has(value)) return PROMPT_CANCEL;
      if (value === "") return submitted(true);
      if (value === "y" || value === "yes") return submitted(true);
      if (value === "n" || value === "no") return submitted(false);
      runtime.write("Please answer y or n (or 0 to cancel).\n");
    }
  }

  async function askText(message: string, signal: AbortSignal): Promise<PromptResult<string>> {
    if (!runtime.isTTY()) throw new CliError("NOT_TTY", "text input requires a TTY");
    const line = await read(signal, `${message}: `);
    if (line === undefined) return promptResultForExit(signal, runtime);
    if (signal.aborted) return PROMPT_ABORT;
    return submitted(line);
  }

  return {
    ...(capabilities ? { capabilities } : {}),
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
    promptText: askText,
    async text(message, signal) {
      const result = await askText(message, signal);
      return result.kind === "submit" ? result.value : undefined;
    },
    note(message) {
      runtime.write(`${message}\n`);
    },
    progress(message) {
      runtime.write(`${message}\n`);
      return {
        update(next) {
          if (next) runtime.write(`${next}\n`);
        },
        stop(done) {
          if (done) runtime.write(`${done}\n`);
        },
      };
    },
    progressBar(label, signal): ProgressBarHandle {
      let latest: ProgressBarEvent = {};
      if (signal.aborted) return { update() {}, stop() {} };
      runtime.write(`${label}\n`);
      return {
        update(event) {
          latest = { ...latest, ...(event ?? {}) };
        },
        stop(message) {
          const summary = renderProgressBar({
            label: latest.label ?? label,
            theme,
            columns: 0,
            ...(latest.done !== undefined ? { done: latest.done } : {}),
            ...(latest.total !== undefined ? { total: latest.total } : {}),
            ...(latest.detail !== undefined ? { detail: latest.detail } : {}),
          });
          runtime.write(message ? `${message}\n${summary}\n` : `${summary}\n`);
        },
      };
    },
    task(label): TaskHandle {
      const print = (state: "success" | "failure" | "timeout", message?: string) => {
        runtime.write(
          `${renderTaskStatus({ state, label, ...(message ? { detail: message } : {}), theme })}\n`,
        );
      };
      return {
        succeed(message) {
          print("success", message);
        },
        fail(message) {
          print("failure", message);
        },
        timeout(message) {
          print("timeout", message);
        },
      };
    },
  };
}

/**
 * Production runtime for `--accessible`: canonical readline input (not raw
 * mode). The adapter owns the interface and closes it in `dispose`.
 */
export function createReadlineUiRuntime(
  options: {
    readonly input?: NodeJS.ReadStream;
    readonly output?: NodeJS.WriteStream;
  } = {},
): AccessibleUiRuntime & { readonly close: () => void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      rl.close();
    } catch {
      /* ignore */
    }
  };
  rl.on("close", () => {
    closed = true;
  });
  return {
    write: (text) => output.write(text),
    async readLine(prompt) {
      try {
        return await rl.question(prompt);
      } catch {
        close();
        return "";
      }
    },
    isTTY: () => Boolean(input.isTTY && output.isTTY),
    eof: () => closed,
    close,
  };
}
