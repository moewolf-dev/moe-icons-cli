import { ConfirmPrompt, SelectPrompt, isCancel } from "@clack/core";
import type { Readable, Writable } from "node:stream";
import type { UiChoice } from "../core/context.js";
import type { UiTheme } from "./theme.js";

export { isCancel };

export interface BrandedPromptIo {
  readonly theme: UiTheme;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
}

export interface SelectFrameState {
  readonly state: string;
  readonly cursor: number;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface ConfirmFrameState {
  readonly state: string;
  readonly value: boolean;
}

export function renderSelectFrame(prompt: SelectFrameState, message: string, theme: UiTheme): string {
  const { pointer, submit, cancel } = theme.symbols;
  if (prompt.state === "cancel") return theme.red(`${cancel} Cancelled`);
  if (prompt.state === "submit") {
    const selected = prompt.options[prompt.cursor];
    return theme.blue(`${submit} ${selected?.label ?? ""}`);
  }
  const lines = [message];
  for (const [index, option] of prompt.options.entries()) {
    if (index === prompt.cursor) lines.push(theme.blue(`${pointer} ${option.label}`));
    else lines.push(`  ${option.label}`);
  }
  return lines.join("\n");
}

export function renderConfirmFrame(prompt: ConfirmFrameState, message: string, theme: UiTheme): string {
  const { radio, submit, cancel } = theme.symbols;
  if (prompt.state === "cancel") return theme.red(`${cancel} Cancelled`);
  if (prompt.state === "submit") {
    return prompt.value ? theme.blue(`${submit} Confirmed`) : theme.red(`${cancel} Cancelled`);
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
  const prompt = new SelectPrompt({
    options: options.choices.map((choice) => ({ value: choice.value, label: choice.label })),
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    render() {
      return renderSelectFrame(this, options.message, options.theme);
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
  const value: unknown = await prompt.prompt();
  if (isCancel(value)) return value;
  return value === true;
}
