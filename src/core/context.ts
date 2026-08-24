export interface CommandUi {
  readonly select: (message: string, choices: readonly string[], signal: AbortSignal) => Promise<string | undefined>;
  readonly confirm: (message: string, signal: AbortSignal) => Promise<boolean | undefined>;
  readonly text: (message: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly note: (message: string, signal: AbortSignal) => void;
}

/** Dependencies shared by command use cases; it deliberately contains no Node globals. */
export interface CommandContext {
  readonly ui: CommandUi;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly now: () => Date;
}
