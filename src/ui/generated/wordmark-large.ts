/**
 * Frozen DOS Rebel "MOEICONS" wordmark (PLAN 2026-09-07).
 * No ANSI. Trailing spaces stripped. Glyph column ranges are exclusive `end`.
 * Colors alternate blue/red by letter; ██ keep the terminal default foreground.
 */

export const WORDMARK_LARGE_WIDTH = 101;

/** Eight content rows; max visible width is 101. */
export const MOEICONS_WORDMARK_LARGE = [
  " ██████   ██████    ███████    ██████████ █████   █████████     ███████    ██████   █████  █████████",
  "░░██████ ██████   ███░░░░░███ ░░███░░░░░█░░███   ███░░░░░███  ███░░░░░███ ░░██████ ░░███  ███░░░░░███",
  " ░███░█████░███  ███     ░░███ ░███  █ ░  ░███  ███     ░░░  ███     ░░███ ░███░███ ░███ ░███    ░░░",
  " ░███░░███ ░███ ░███      ░███ ░██████    ░███ ░███         ░███      ░███ ░███░░███░███ ░░█████████",
  " ░███ ░░░  ░███ ░███      ░███ ░███░░█    ░███ ░███         ░███      ░███ ░███ ░░██████  ░░░░░░░░███",
  " ░███      ░███ ░░███     ███  ░███ ░   █ ░███ ░░███     ███░░███     ███  ░███  ░░█████  ███    ░███",
  " █████     █████ ░░░███████░   ██████████ █████ ░░█████████  ░░░███████░   █████  ░░█████░░█████████",
  "░░░░░     ░░░░░    ░░░░░░░    ░░░░░░░░░░ ░░░░░   ░░░░░░░░░     ░░░░░░░    ░░░░░    ░░░░░  ░░░░░░░░░",
] as const;

export type WordmarkGlyphColor = "blue" | "red";

export interface WordmarkGlyphRegion {
  readonly letter: string;
  readonly start: number;
  readonly end: number;
  readonly shade: WordmarkGlyphColor;
}

/** DOS Rebel per-letter advance widths; indices assume a 101-column padded canvas. */
export const WORDMARK_LARGE_GLYPHS: readonly WordmarkGlyphRegion[] = [
  { letter: "M", start: 0, end: 16, shade: "blue" },
  { letter: "O", start: 16, end: 30, shade: "red" },
  { letter: "E", start: 30, end: 41, shade: "blue" },
  { letter: "I", start: 41, end: 47, shade: "red" },
  { letter: "C", start: 47, end: 60, shade: "blue" },
  { letter: "O", start: 60, end: 74, shade: "red" },
  { letter: "N", start: 74, end: 89, shade: "blue" },
  { letter: "S", start: 89, end: 101, shade: "red" },
] as const;
