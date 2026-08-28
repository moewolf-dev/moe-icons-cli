import packageJson from "../../package.json" with { type: "json" };
import { MOEICONS_LOGO_ASCII } from "./generated/logo-ascii.js";
import { MOEICONS_BANNER } from "./generated/wordmark.js";
import { createTheme } from "./theme.js";

export { MOEICONS_BANNER };

const CANVAS_WIDTH = 47;
const MIN_FULL_COLUMNS = 52;

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const COMBINING_MARK = /\p{Mark}/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const WIDE_CODEPOINT =
  "[" +
  "\u1100-\u115f" + // Hangul jamo
  "\u2e80-\u303e" + // CJK radicals, Kangxi, punctuation
  "\u3041-\u33ff" + // Hiragana/Katakana, CJK symbols, enclosed
  "\u3400-\u4dbf" + // CJK ext A
  "\u4e00-\u9fff" + // CJK unified
  "\ua000-\ua4cf" + // Yi
  "\uac00-\ud7a3" + // Hangul syllables
  "\uf900-\ufaff" + // CJK compat
  "\ufe30-\ufe4f" + // CJK compat forms
  "\uff00-\uff60" + // fullwidth forms
  "\uffe0-\uffe6" + // fullwidth signs
  "]";
const WIDE_CHAR = new RegExp(WIDE_CODEPOINT, "u");

export const CLI_NOTICE_LINES = [
  "Run moeicons from your project root.",
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

export function renderBannerText(options: RenderBannerOptions): string {
  const columns = normalizeColumns(options.columns);
  const notice = renderNoticeBox(CLI_NOTICE_LINES, { width: Math.max(20, columns) });
  if (columns < MIN_FULL_COLUMNS) {
    return `MOEICONS\n${notice}\n`;
  }
  const theme = createTheme(options.color);
  const logo = centerLines(contentLines(MOEICONS_LOGO_ASCII)).map((line) => theme.blue(line));
  const wordmark = centerLines(contentLines(MOEICONS_BANNER));
  return `${logo.join("\n")}\n\n${wordmark.join("\n")}\n${notice}\n`;
}

export const CLI_VERSION = packageJson.version;
