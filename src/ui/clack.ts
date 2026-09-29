import * as p from "@clack/prompts";
import { isCancel } from "@clack/core";
import { CliError } from "../errors/index.js";
import type { CommandUi, ProgressBarEvent, ProgressBarHandle, TaskHandle } from "../core/context.js";
import { brandedConfirm, brandedSelect } from "./branded-prompts.js";
import { renderProgressBar, renderTaskStatus } from "../tui/components.js";
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
    // W3-A: clack has no bar primitive, so the bar is rendered as the spinner
    // message. Unknown totals degrade to a byte counter (never a fake percent).
    progressBar(label, signal): ProgressBarHandle {
      throwIfAborted(signal);
      const spinner = p.spinner();
      spinner.start(label);
      const startedAt = Date.now();
      let latest: ProgressBarEvent = {};
      const paint = () => {
        const columns = process.stdout?.columns ?? 80;
        spinner.message(
          renderProgressBar({
            label: latest.label ?? label,
            theme: options.theme,
            columns,
            elapsedMs: Date.now() - startedAt,
            ...(latest.done !== undefined ? { done: latest.done } : {}),
            ...(latest.total !== undefined ? { total: latest.total } : {}),
            ...(latest.detail !== undefined ? { detail: latest.detail } : {}),
          }),
        );
      };
      return {
        update(event) {
          latest = { ...latest, ...(event ?? {}) };
          paint();
        },
        stop(done) { spinner.stop(done ?? renderTaskStatus({ state: "success", label, theme: options.theme })); },
      };
    },
    // W3-C: strict task lifecycle for work without a progress bar.
    task(label, signal): TaskHandle {
      throwIfAborted(signal);
      const spinner = p.spinner();
      spinner.start(`${options.theme.dim("…")} ${label}`);
      const finish = (state: "success" | "failure" | "timeout", message?: string) => {
        spinner.stop(renderTaskStatus({ state, label, ...(message ? { detail: message } : {}), theme: options.theme }));
      };
      return {
        succeed(message) { finish("success", message); },
        fail(message) { finish("failure", message); },
        timeout(message) { finish("timeout", message); },
      };
    },
  };
}
