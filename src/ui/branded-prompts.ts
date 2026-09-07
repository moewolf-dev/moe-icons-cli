import { ConfirmPrompt, SelectPrompt, isCancel } from "@clack/core";
import type { Readable, Writable } from "node:stream";
import type { UiChoice } from "../core/context.js";
import type { UiTheme } from "./theme.js";
import { visibleWidth } from "./banner.js";

export { isCancel };

export interface BrandedPromptIo {
  readonly theme: UiTheme;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
}

export interface SelectFrameOption {
  readonly value: string;
  readonly label: string;
  readonly separatorBefore?: boolean;
}

export interface SelectFrameState {
  readonly state: string;
  readonly cursor: number;
  readonly options: readonly SelectFrameOption[];
}

export interface ConfirmFrameState {
  readonly state: string;
  readonly value: boolean;
}

/** Format `1. label` with stable width for lists of 10+. */
export function formatChoiceNumber(index: number, total: number, label: string): string {
  const width = String(Math.max(total, 1)).length;
  return `${String(index + 1).padStart(width, " ")}. ${label}`;
}

/** Renders every option with 1-based numbers. Back separators are blank lines. */
export function renderSelectFrame(prompt: SelectFrameState, message: string, theme: UiTheme): string {
  const { pointer, submit, cancel } = theme.symbols;
  const total = prompt.options.length;
  const numbered = (index: number, label: string) => formatChoiceNumber(index, total, label);

  if (prompt.state === "cancel") return theme.red(`${cancel} Cancelled`);
  if (prompt.state === "submit") {
    const selected = prompt.options[prompt.cursor];
    return theme.blue(`${submit} ${selected ? numbered(prompt.cursor, selected.label) : ""}`);
  }

  const lines = [message];
  const inactivePad = " ".repeat(visibleWidth(pointer) + 1);
  for (const [index, option] of prompt.options.entries()) {
    if (option.separatorBefore) lines.push("");
    const text = numbered(index, option.label);
    if (index === prompt.cursor) lines.push(theme.blue(`${pointer} ${text}`));
    else lines.push(`${inactivePad}${text}`);
  }
  return lines.join("\n");
}

export function renderConfirmFrame(prompt: ConfirmFrameState, message: string, theme: UiTheme): string {
  const { radio, submit, cancel } = theme.symbols;
  if (prompt.state === "cancel") return theme.red(`${cancel} Cancelled`);
  if (prompt.state === "submit") {
    return prompt.value ? theme.blue(`${submit} Confirmed`) : theme.red(`${cancel} No`);
  }
  const yes = prompt.value ? theme.blue(`${radio} Yes`) : theme.blue("Yes");
  const no = prompt.value ? theme.red("No") : theme.red(`${radio} No`);
  return `${message}\n${yes}  ${no}`;
}

export async function brandedSelect(
  options: BrandedPromptIo & {
    readonly message: string;
    readonly choices: readonly UiChoice[];
  },
): Promise<string | symbol> {
  const frameOptions: SelectFrameOption[] = options.choices.map((choice) => ({
    value: choice.value,
    label: choice.label,
    ...(choice.separatorBefore ? { separatorBefore: true as const } : {}),
  }));
  const prompt = new SelectPrompt({
    options: frameOptions.map((choice) => ({ value: choice.value, label: choice.label })),
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    render() {
      return renderSelectFrame(
        { state: this.state, cursor: this.cursor, options: frameOptions },
        options.message,
        options.theme,
      );
    },
  });
  return prompt.prompt();
}

export async function brandedConfirm(
  options: BrandedPromptIo & { readonly message: string },
): Promise<boolean | symbol> {
  const prompt = new ConfirmPrompt({
    active: "Yes",
    inactive: "No",
    initialValue: true,
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    render() {
      return renderConfirmFrame(this, options.message, options.theme);
    },
  });
  const value = await prompt.prompt();
  if (isCancel(value)) return value;
  return Boolean(value);
}
