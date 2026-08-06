import { CliError } from "../errors/index.js";

/**
 * CLI-04: TUI primitives with injected streams. Business modules never import
 * this; command handlers inject their own streams. Non-TTY detection and
 * cancellation are first-class. Avoids brittle terminal timing.
 */

export interface TuiStreams {
  readonly isTTY: () => boolean;
  readonly write: (text: string) => void;
  readonly readLine: (prompt: string) => Promise<string>;
  readonly readKey: () => Promise<string>;
}

export interface TuiDeps {
  readonly streams: TuiStreams;
  readonly signal?: AbortSignal;
}

export type Choice<T> = { readonly value: T; readonly label: string };

export interface SelectOptions<T> {
  readonly choices: readonly Choice<T>[];
  readonly canCancel?: boolean;
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

function assertNotAborted(deps: TuiDeps): void {
  if (deps.signal?.aborted) throw new CancelledError();
}

/** Render a banner. No TTY required. */
export function renderBanner(deps: TuiDeps, banner: string): void {
  deps.streams.write(banner);
  deps.streams.write("\n");
}

/** Interactive single-choice selection; non-TTY rejects with guidance. */
export async function select<T>(deps: TuiDeps, prompt: string, options: SelectOptions<T>): Promise<T> {
  assertNotAborted(deps);
  if (!deps.streams.isTTY()) {
    throw new CliError("NOT_TTY", "interactive selection requires a TTY; use a specific command or --json");
  }
  deps.streams.write(`${prompt}\n`);
  options.choices.forEach((choice, i) => {
    deps.streams.write(`  ${i + 1}) ${choice.label}\n`);
  });
  if (options.canCancel) deps.streams.write("  0) Cancel\n");

  for (;;) {
    const line = (await deps.streams.readLine("> ")).trim();
    assertNotAborted(deps);
    if (options.canCancel && (line === "0" || line.toLowerCase() === "cancel")) {
      throw new CancelledError();
    }
    const index = Number(line);
    const choice = options.choices[index - 1];
    if (choice) return choice.value;
    deps.streams.write("Invalid choice. Try again.\n");
  }
}

/** Yes/no confirmation; default from options. */
export async function confirm(deps: TuiDeps, prompt: string, defaultValue: boolean): Promise<boolean> {
  assertNotAborted(deps);
  if (!deps.streams.isTTY()) {
    return defaultValue;
  }
  for (;;) {
    const line = (await deps.streams.readLine(`${prompt} [y/N] `)).trim().toLowerCase();
    assertNotAborted(deps);
    if (line === "y" || line === "yes") return true;
    if (line === "n" || line === "no") return false;
    if (line === "") return defaultValue;
    deps.streams.write("Please answer y or n.\n");
  }
}

/** Masked key input (echo replaced with bullets). Non-TTY rejects. */
export async function maskedInput(deps: TuiDeps, prompt: string): Promise<string> {
  assertNotAborted(deps);
  if (!deps.streams.isTTY()) {
    throw new CliError("NOT_TTY", "masked input requires a TTY");
  }
  deps.streams.write(prompt);
  let value = "";
  for (;;) {
    const key = await deps.streams.readKey();
    if (key === "\r" || key === "\n") break;
    if (key === "\u0003") throw new CancelledError(); // Ctrl+C
    if (key === "\u007f" || key === "\b") {
      value = value.slice(0, -1);
      deps.streams.write("\b \b");
      continue;
    }
    if (key.length === 1 && key >= " ") {
      value += key;
      deps.streams.write("*");
    }
  }
  deps.streams.write("\n");
  return value;
}
