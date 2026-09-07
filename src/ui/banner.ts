import packageJson from "../../package.json" with { type: "json" };
import { MOEICONS_BANNER } from "./generated/wordmark.js";
import {
  MOEICONS_WORDMARK_LARGE,
  WORDMARK_LARGE_GLYPHS,
  WORDMARK_LARGE_WIDTH,
} from "./generated/wordmark-large.js";
import { ANSI_FG_RESET, createTheme, type UiTheme } from "./theme.js";

export { MOEICONS_BANNER };
export {
  MOEICONS_WORDMARK_LARGE,
  WORDMARK_LARGE_GLYPHS,
  WORDMARK_LARGE_WIDTH,
} from "./generated/wordmark-large.js";

const CANVAS_WIDTH = 47;
/** Figlet / mid tier when columns are in [52, 101). */
export const MIN_FIGLET_COLUMNS = 52;
/** Large Unicode wordmark when columns >= 101. */
export const MIN_LARGE_COLUMNS = WORDMARK_LARGE_WIDTH;

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const COMBINING_MARK = /\p{Mark}/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const WIDE_CODEPOINT =
  "[" +
  "\u1100-\u115f" +
  "\u2e80-\u303e" +
  "\u3041-\u33ff" +
  "\u3400-\u4dbf" +
  "\u4e00-\u9fff" +
  "\ua000-\ua4cf" +
  "\uac00-\ud7a3" +
  "\uf900-\ufaff" +
  "\ufe30-\ufe4f" +
  "\uff00-\uff60" +
  "\uffe0-\uffe6" +
  "]";
const WIDE_CHAR = new RegExp(WIDE_CODEPOINT, "u");

export const CLI_NOTICE_LINES = [
  "Run `moeicons` from your project root.",
  "React/Vue targets require the matching framework.",
  "Automatic Tailwind integration supports v3 only.",
  "Vanilla and Assets do not require React or Vue.",
] as const;

/** wcwidth-style display width for a single Unicode code point. */
function codepointWidth(character: string): number {
  if (COMBINING_MARK.test(character)) return 0;
  if (CONTROL.test(character)) return 0;
  if (WIDE_CHAR.test(character)) return 2;
  return 1;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

/** Visible terminal width: ANSI sequences and combining marks take no columns. */
export function visibleWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) width += codepointWidth(character);
  return width;
}

const ANSI_OR_CHAR = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]|[\\s\\S]`, "gu");

/** Truncate to `maxWidth` visible columns, preserving ANSI sequences seen so far. */
function truncateLine(value: string, maxWidth: number): string {
  if (visibleWidth(value) <= maxWidth) return value;
  const budget = maxWidth - 1;
  let result = "";
  let width = 0;
  for (const token of value.matchAll(ANSI_OR_CHAR)) {
    const part = token[0];
    if (part.startsWith(String.fromCharCode(27))) {
      result += part;
      continue;
    }
    const tokenWidth = codepointWidth(part);
    if (width + tokenWidth > budget) {
      result += "…";
      break;
    }
    result += part;
    width += tokenWidth;
  }
  return result;
}

/** Pad to `width` visible columns, ignoring ANSI escapes. */
function padLine(value: string, width: number): string {
  const missing = width - visibleWidth(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

/** Render an adaptive notice box without splitting ANSI escapes or Unicode characters. */
export function renderNoticeBox(
  message: string | readonly string[],
  options: { readonly width?: number; readonly unicode?: boolean } = {},
): string {
  const lines = typeof message === "string" ? message.split("\n") : [...message];
  const available = Math.max(4, options.width ?? 80);
  const widest = lines.length > 0 ? Math.max(...lines.map(visibleWidth)) : 1;
  const contentWidth = Math.min(Math.max(widest, 1), Math.max(1, available - 4));
  const unicode = options.unicode ?? true;
  const [top, side, bottom, topRight, bottomRight] = unicode
    ? ["┌", "│", "└", "┐", "┘"]
    : ["+", "|", "+", "+", "+"];
  const horizontal = unicode ? "─" : "-";
  return [
    `${top}${horizontal.repeat(contentWidth + 2)}${topRight}`,
    ...lines.map((line) => `${side} ${padLine(truncateLine(line, contentWidth), contentWidth)} ${side}`),
    `${bottom}${horizontal.repeat(contentWidth + 2)}${bottomRight}`,
  ].join("\n");
}

export interface RenderBannerOptions {
  readonly columns: number;
  readonly color: boolean;
}

export type WordmarkTier = "large" | "figlet" | "single";

function normalizeColumns(columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 80;
  return columns;
}

function contentLines(value: string): string[] {
  const lines = value.split("\n");
  while (lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Left-pad lines onto a canvas. Never adds trailing spaces. */
export function centerLines(lines: readonly string[], width = CANVAS_WIDTH): string[] {
  return lines.map((line) => {
    const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
    return pad > 0 ? `${" ".repeat(pad)}${line}` : line;
  });
}

export function selectWordmarkTier(columns: number): WordmarkTier {
  const normalized = normalizeColumns(columns);
  if (normalized >= MIN_LARGE_COLUMNS) return "large";
  if (normalized >= MIN_FIGLET_COLUMNS) return "figlet";
  return "single";
}

function glyphShadeAt(column: number): "blue" | "red" | undefined {
  for (const glyph of WORDMARK_LARGE_GLYPHS) {
    if (column >= glyph.start && column < glyph.end) return glyph.shade;
  }
  return undefined;
}

/**
 * Paint ░ runs with brand blue/red by frozen glyph intervals.
 * ██ keep the default foreground. Disable color with theme.enabled=false.
 */
export function paintWordmarkLarge(lines: readonly string[], theme: UiTheme): string[] {
  const openBlue = "\x1b[38;2;59;130;246m";
  const openRed = "\x1b[38;2;239;68;68m";
  return lines.map((line) => {
    const padded = line.padEnd(WORDMARK_LARGE_WIDTH, " ");
    if (!theme.enabled) return padded.replace(/ +$/u, "");
    let result = "";
    let active: "blue" | "red" | undefined;
    for (let column = 0; column < WORDMARK_LARGE_WIDTH; column += 1) {
      const character = padded[column] ?? " ";
      if (character === "░") {
        const shade = glyphShadeAt(column) ?? "blue";
        if (active !== shade) {
          if (active !== undefined) result += ANSI_FG_RESET;
          result += shade === "blue" ? openBlue : openRed;
          active = shade;
        }
        result += character;
      } else {
        if (active !== undefined) {
          result += ANSI_FG_RESET;
          active = undefined;
        }
        result += character;
      }
    }
    if (active !== undefined) result += ANSI_FG_RESET;
    return result.replace(/ +$/u, "");
  });
}

/** Wordmark only (no notices). Used by wizard startup ordering. */
export function renderWordmarkText(options: RenderBannerOptions): string {
  const columns = normalizeColumns(options.columns);
  const tier = selectWordmarkTier(columns);
  if (tier === "single") return "MOEICONS";
  if (tier === "figlet") return centerLines(contentLines(MOEICONS_BANNER)).join("\n");
  const theme = createTheme(options.color);
  return paintWordmarkLarge([...MOEICONS_WORDMARK_LARGE], theme).join("\n");
}

/** Project-root / dependency notice box for the current terminal width. */
export function renderProjectNotice(columns: number): string {
  return renderNoticeBox(CLI_NOTICE_LINES, { width: Math.max(20, normalizeColumns(columns)) });
}

/**
 * Combined wordmark + project notice.
 * Wizard prefers renderWordmarkText then version/update then renderProjectNotice.
 */
export function renderBannerText(options: RenderBannerOptions): string {
  const columns = normalizeColumns(options.columns);
  const wordmark = renderWordmarkText(options);
  const notice = renderProjectNotice(columns);
  return `${wordmark}\n${notice}\n`;
}

export const CLI_VERSION = packageJson.version;
