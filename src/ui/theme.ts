export const ANSI_FG_RESET = "\x1b[39m";
export const BRAND_BLUE_RGB = { r: 59, g: 130, b: 246 } as const;
export const BRAND_RED_RGB = { r: 239, g: 68, b: 68 } as const;

export const THEME_SYMBOLS = {
  pointer: "›",
  radio: "●",
  submit: "◆",
  cancel: "■",
} as const;

export interface UiTheme {
  readonly enabled: boolean;
  readonly blue: (text: string) => string;
  readonly red: (text: string) => string;
  readonly symbols: typeof THEME_SYMBOLS;
}

function ansiFg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
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

export function createTheme(enabled: boolean): UiTheme {
  return {
    enabled,
    blue: paint(enabled, BRAND_BLUE_RGB.r, BRAND_BLUE_RGB.g, BRAND_BLUE_RGB.b),
    red: paint(enabled, BRAND_RED_RGB.r, BRAND_RED_RGB.g, BRAND_RED_RGB.b),
    symbols: THEME_SYMBOLS,
  };
}
