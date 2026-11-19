/**
 * REF-02 / REF-03 / P0-00: one injectable description of what the terminal can
 * actually do. Adapters consume this object instead of reading `process.*`
 * directly, so tests can describe a 10-column, no-colour, no-Unicode terminal.
 *
 * Precedence (documented in docs/cli-product-references/matrices/compatibility.md):
 * explicit CLI flag/config > environment variable > measured TTY capability >
 * conservative default.
 */

export interface TerminalCapabilities {
  /** Prompts can read keyboard input (stdin is a TTY and input is not JSON). */
  readonly interactiveInput: boolean;
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
  readonly stderrTTY: boolean;
  /** Measured output width; `undefined` means unknown/invalid. */
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly color: boolean;
  readonly unicode: boolean;
  /** Safe to repaint a single dynamic line (spinner/progress). */
  readonly dynamicRedraw: boolean;
  readonly reducedMotion: boolean;
  /** Static numbered input + no animation (screen-reader friendly). */
  readonly accessible: boolean;
  readonly ci: boolean;
}

export interface CapabilityEnv {
  readonly [key: string]: string | undefined;
}

export interface DetectCapabilitiesInput {
  readonly env: CapabilityEnv;
  readonly json?: boolean;
  readonly yes?: boolean;
  readonly stdinTTY?: boolean;
  readonly stdoutTTY?: boolean;
  readonly stderrTTY?: boolean;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  /** Explicit user choice, e.g. `--accessible`/`--no-color`. */
  readonly accessible?: boolean;
  readonly color?: boolean;
  readonly unicode?: boolean;
}

/** A zero, NaN, negative or non-finite width is "unknown", never a tiny terminal. */
export function normalizeColumns(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function resolveColumns(columns: number | undefined, fallback = 80): number {
  return normalizeColumns(columns) ?? fallback;
}

export function isCi(env: CapabilityEnv): boolean {
  return env.CI === "true" || env.CI === "1" || env.CONTINUOUS_INTEGRATION === "true";
}

function envFlag(env: CapabilityEnv, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value === "" || value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return undefined;
}

export function detectCapabilities(input: DetectCapabilitiesInput): TerminalCapabilities {
  const { env } = input;
  const stdinTTY = input.stdinTTY ?? false;
  const stdoutTTY = input.stdoutTTY ?? false;
  const interactiveInput = !input.json && stdinTTY && stdoutTTY;
  const noColor = Object.prototype.hasOwnProperty.call(env, "NO_COLOR");
  const dumb = env.TERM === "dumb";
  const color = input.color ?? (stdoutTTY && !noColor && !dumb && env.FORCE_COLOR !== "0");
  const ascii = envFlag(env, "MOEICONS_ASCII") ?? (dumb ? true : undefined);
  const unicode = input.unicode ?? !(ascii ?? false);
  const ci = isCi(env);
  const accessible =
    input.accessible ??
    envFlag(env, "MOEICONS_ACCESSIBLE") ??
    envFlag(env, "MOEICONS_STATIC") ??
    false;
  const reducedMotion = envFlag(env, "MOEICONS_REDUCED_MOTION") ?? (ci || accessible || dumb);
  return {
    interactiveInput,
    stdinTTY,
    stdoutTTY,
    stderrTTY: input.stderrTTY ?? false,
    columns: normalizeColumns(input.columns),
    rows:
      input.rows !== undefined && Number.isFinite(input.rows) && input.rows > 0
        ? input.rows
        : undefined,
    color,
    unicode,
    dynamicRedraw: interactiveInput && !ci && !accessible && !dumb && env.TERM !== undefined,
    reducedMotion,
    accessible,
    ci,
  };
}

/** The conservative capability set for JSON/non-TTY output. */
export function nonInteractiveCapabilities(): TerminalCapabilities {
  return detectCapabilities({
    env: {},
    json: true,
    stdinTTY: false,
    stdoutTTY: false,
    stderrTTY: false,
  });
}
