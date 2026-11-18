import type { PromptResult } from "./prompt-result.js";
import { PROMPT_ABORT, PROMPT_CANCEL, submitted } from "./prompt-result.js";
import type { TerminalCapabilities } from "../ui/capabilities.js";

export interface UiChoice {
  readonly value: string;
  readonly label: string;
  /** When true, renderer inserts a blank line before this option (e.g. Back). */
  readonly separatorBefore?: boolean;
}

/** W3-A: a structured progress tick (bytes or item counts). */
export interface ProgressBarEvent {
  readonly done?: number;
  readonly total?: number;
  readonly label?: string;
  readonly detail?: string;
}

export interface ProgressBarHandle {
  readonly update: (event?: ProgressBarEvent) => void;
  readonly stop: (message?: string) => void;
}

/** W3-C: strict task lifecycle for work without a progress bar. */
export interface TaskHandle {
  readonly succeed: (message?: string) => void;
  readonly fail: (message?: string) => void;
  readonly timeout: (message?: string) => void;
}

export interface CommandUi {
  readonly select: (
    message: string,
    choices: readonly UiChoice[],
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  readonly confirm: (message: string, signal: AbortSignal) => Promise<boolean | undefined>;
  readonly text: (message: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly note: (message: string, signal: AbortSignal) => void;
  readonly progress: (
    message: string,
    signal: AbortSignal,
  ) => { readonly update?: (message: string) => void; readonly stop: (message?: string) => void };
  /**
   * W3-A: optional richer progress surface. Adapters that cannot render one
   * (JSON / non-TTY) omit it; callers fall back to `progress`.
   */
  readonly progressBar?: (label: string, signal: AbortSignal) => ProgressBarHandle;
  /** W3-C: optional strict task status surface. */
  readonly task?: (label: string, signal: AbortSignal) => TaskHandle;
  /**
   * REF-01/P1-04: canonical prompt outcomes. Adapters that implement these
   * distinguish submit / back / cancel / abort; the legacy `select`/`confirm`
   * members remain for compatibility and are derived when absent.
   */
  readonly promptSelect?: (
    message: string,
    choices: readonly UiChoice[],
    signal: AbortSignal,
  ) => Promise<PromptResult<string>>;
  readonly promptConfirm?: (message: string, signal: AbortSignal) => Promise<PromptResult<boolean>>;
  readonly promptText?: (message: string, signal: AbortSignal) => Promise<PromptResult<string>>;
  /** REF-02/03: capability snapshot owned by the adapter. */
  readonly capabilities?: TerminalCapabilities;
  /** REF-01: release any terminal resources (cursor/raw mode/listeners). */
  readonly dispose?: () => void;
}

/** Prefer the canonical prompt contract, falling back to legacy adapters. */
export async function promptSelect(
  ui: CommandUi,
  message: string,
  choices: readonly UiChoice[],
  signal: AbortSignal,
): Promise<PromptResult<string>> {
  if (ui.promptSelect) return ui.promptSelect(message, choices, signal);
  const value = await ui.select(message, choices, signal);
  if (value !== undefined) return submitted(value);
  return signal.aborted ? PROMPT_ABORT : PROMPT_CANCEL;
}

export async function promptConfirm(
  ui: CommandUi,
  message: string,
  signal: AbortSignal,
): Promise<PromptResult<boolean>> {
  if (ui.promptConfirm) return ui.promptConfirm(message, signal);
  const value = await ui.confirm(message, signal);
  if (value !== undefined) return submitted(value);
  return signal.aborted ? PROMPT_ABORT : PROMPT_CANCEL;
}

export async function promptText(
  ui: CommandUi,
  message: string,
  signal: AbortSignal,
): Promise<PromptResult<string>> {
  if (ui.promptText) return ui.promptText(message, signal);
  const value = await ui.text(message, signal);
  if (value !== undefined) return submitted(value);
  return signal.aborted ? PROMPT_ABORT : PROMPT_CANCEL;
}

/** Dependencies shared by command use cases; it deliberately contains no Node globals. */
export interface CommandContext {
  readonly ui: CommandUi;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly now: () => Date;
}
