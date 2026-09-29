export const ANSI_FG_RESET = "\x1b[39m";
export const ANSI_DIM_OPEN = "\x1b[2m";
export const ANSI_DIM_RESET = "\x1b[22m";
export const BRAND_BLUE_RGB = { r: 59, g: 130, b: 246 } as const;
export const BRAND_RED_RGB = { r: 239, g: 68, b: 68 } as const;

export const THEME_SYMBOLS = {
  pointer: "›",
  radio: "●",
  submit: "◆",
  cancel: "■",
  // W3: task-status glyphs. Colour stays within the frozen white/blue/red
  // palette (success = blue, failure/timeout = red), so the theme keeps working
  // with NO_COLOR and a dumb terminal.
  success: "✔",
  failure: "✖",
  timeout: "⏱",
  pending: "…",
  barFilled: "█",
  barEmpty: "░",
} as const;

export interface UiTheme {
  readonly enabled: boolean;
  readonly blue: (text: string) => string;
  readonly red: (text: string) => string;
  /** W3: de-emphasised text for key hints and secondary detail. */
  readonly dim: (text: string) => string;
  /** Raw SGR open sequences for multi-span painting (empty when color is off). */
  readonly openBlue: string;
  readonly openRed: string;
  readonly openDim: string;
  readonly symbols: typeof THEME_SYMBOLS;
}

function ansiFg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Brand SGR open sequence; only place outside theme that should need RGB → ANSI. */
export function brandAnsiFgOpen(color: "blue" | "red"): string {
  const rgb = color === "blue" ? BRAND_BLUE_RGB : BRAND_RED_RGB;
  return ansiFg(rgb.r, rgb.g, rgb.b);
}

/** Do not nest `theme.blue`/`theme.red`: reset returns to the default foreground, not an outer color. */
function paint(enabled: boolean, r: number, g: number, b: number): (text: string) => string {
  const open = ansiFg(r, g, b);
  return (text: string) => (enabled ? `${open}${text}${ANSI_FG_RESET}` : text);
}

/** Banner and branded prompts only. Does not control leftover Clack text/note/spinner colors. */
export function isThemeEnabled(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
): boolean {
  if (!isTTY) return false;
  if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR")) return false;
  if (env.TERM === "dumb") return false;
  return true;
}

/** Dim/intensity paint. Independent of foreground colour, so it composes safely. */
function paintDim(enabled: boolean): (text: string) => string {
  return (text: string) => (enabled ? `${ANSI_DIM_OPEN}${text}${ANSI_DIM_RESET}` : text);
}

export function createTheme(enabled: boolean): UiTheme {
  return {
    enabled,
    blue: paint(enabled, BRAND_BLUE_RGB.r, BRAND_BLUE_RGB.g, BRAND_BLUE_RGB.b),
    red: paint(enabled, BRAND_RED_RGB.r, BRAND_RED_RGB.g, BRAND_RED_RGB.b),
    dim: paintDim(enabled),
    openBlue: enabled ? brandAnsiFgOpen("blue") : "",
    openRed: enabled ? brandAnsiFgOpen("red") : "",
    openDim: enabled ? ANSI_DIM_OPEN : "",
    symbols: THEME_SYMBOLS,
  };
}
