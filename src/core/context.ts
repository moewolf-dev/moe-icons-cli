export interface UiChoice {
  readonly value: string;
  readonly label: string;
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
  readonly progress: (message: string, signal: AbortSignal) => { readonly update?: (message: string) => void; readonly stop: (message?: string) => void };
}

/** Dependencies shared by command use cases; it deliberately contains no Node globals. */
export interface CommandContext {
  readonly ui: CommandUi;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly now: () => Date;
}
