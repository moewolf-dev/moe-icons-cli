import { formatBytes } from "../metadata/version.js";
import { visibleWidth } from "../ui/banner.js";
import type { UiTheme } from "../ui/theme.js";

/**
 * W3-A/C/D/E: pure TUI component renderers.
 *
 * Kept dependency-free (no stream/Clack/process access) so every frame is unit
 * testable and the adapters (`ui/clack.ts`, `ui/stream.ts`,
 * `ui/non-interactive.ts`) only own I/O. Colour is always supplied through the
 * shared `UiTheme` (white / brand blue / brand red + a dim intensity), never a
 * hardcoded escape, and every renderer degrades to plain text when colour is
 * disabled or the output is not a TTY.
 */

export const PROGRESS_GLYPHS = Object.freeze({
  filled: "█",
  empty: "░",
});

/** W3-C running animation frames. Deterministic by frame index. */
export const TASK_RUNNING_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

export type TaskState = "running" | "success" | "failure" | "timeout";
export type HistoryState = "running" | "success" | "failure" | "timeout";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatRate(bytes: number, elapsedMs: number): string | undefined {
  if (!Number.isFinite(bytes) || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || bytes <= 0) return undefined;
  const perSecond = bytes / (elapsedMs / 1000);
  return `${formatBytes(Math.round(perSecond))}/s`;
}

export interface ProgressBarInput {
  readonly label: string;
  readonly done?: number;
  readonly total?: number;
  readonly detail?: string;
  readonly columns?: number;
  readonly theme: UiTheme;
  /** Elapsed wall time in ms; enables the rate suffix. */
  readonly elapsedMs?: number;
  /** Fixed bar width override (tests); otherwise derived from `columns`. */
  readonly barWidth?: number;
}

function progressBarWidth(columns: number, labelWidth: number, suffixWidth: number): number {
  const available = columns - labelWidth - suffixWidth - 4;
  return clamp(available, 8, 40);
}

/**
 * W3-A: one-line progress bar with percentage, transferred/total bytes, an
 * optional rate and a detail suffix. Unknown total renders a byte-only line
 * (never a fake percentage). `columns <= 0` (non-TTY) collapses to a log line.
 */
export function renderProgressBar(input: ProgressBarInput): string {
  const { theme, label } = input;
  const done = Math.max(0, input.done ?? 0);
  const total = input.total !== undefined && input.total > 0 ? input.total : undefined;
  const columns = input.columns ?? 80;
  const detail = input.detail ? ` ${theme.dim(input.detail)}` : "";
  const rate = input.elapsedMs !== undefined ? formatRate(done, input.elapsedMs) : undefined;

  if (columns <= 0) {
    const suffix = total !== undefined ? `${formatBytes(done)}/${formatBytes(total)}` : formatBytes(done);
    return `${label} ${suffix}${rate ? ` (${rate})` : ""}${input.detail ? ` ${input.detail}` : ""}`;
  }

  if (total === undefined) {
    return `${label} ${formatBytes(done)}${rate ? ` (${rate})` : ""}${detail}`;
  }

  const ratio = clamp(done / total, 0, 1);
  const percent = Math.floor(ratio * 100);
  const suffix = `${String(percent).padStart(3, " ")}% ${formatBytes(done)}/${formatBytes(total)}${rate ? ` ${rate}` : ""}`;
  // Budget by VISIBLE width: the label/suffix may carry ANSI (e.g. a dim rate),
  // which must not eat into the bar's column budget.
  const width = input.barWidth ?? progressBarWidth(columns, visibleWidth(label), visibleWidth(suffix));
  const filled = Math.round(width * ratio);
  const bar = `${theme.blue(PROGRESS_GLYPHS.filled.repeat(filled))}${theme.dim(PROGRESS_GLYPHS.empty.repeat(width - filled))}`;
  return `${label} ${bar} ${suffix}${detail}`;
}

export interface TaskStatusInput {
  readonly state: TaskState;
  readonly label: string;
  readonly detail?: string;
  readonly frame?: number;
  readonly theme: UiTheme;
}

/** W3-C: strict four-state task status with a lightweight running animation. */
export function renderTaskStatus(input: TaskStatusInput): string {
  const { theme, state, label } = input;
  const detail = input.detail ? ` ${theme.dim(input.detail)}` : "";
  if (state === "success") return `${theme.blue(theme.symbols.success)} ${label}${detail}`;
  if (state === "failure") return `${theme.red(theme.symbols.failure)} ${label}${detail}`;
  if (state === "timeout") return `${theme.red(theme.symbols.timeout)} ${label}${detail}`;
  const frame = TASK_RUNNING_FRAMES[Math.abs(input.frame ?? 0) % TASK_RUNNING_FRAMES.length] ?? "…";
  return `${theme.blue(frame)} ${label}${detail}`;
}

export interface KeyHint {
  readonly key: string;
  readonly label: string;
}

export const SELECT_KEY_HINTS: readonly KeyHint[] = Object.freeze([
  { key: "↑/↓", label: "move" },
  { key: "1-9", label: "select" },
  { key: "Enter", label: "submit" },
  { key: "Esc", label: "cancel" },
]);

export const CONFIRM_KEY_HINTS: readonly KeyHint[] = Object.freeze([
  { key: "Y/N", label: "choose" },
  { key: "Enter", label: "submit" },
  { key: "Esc", label: "cancel" },
]);

/** W3-D: low-opacity, small key hints for a pure-keyboard workflow. */
export function renderKeyHints(hints: readonly KeyHint[], theme: UiTheme): string {
  return theme.dim(hints.map((hint) => `${hint.key} ${hint.label}`).join(" · "));
}

export interface HistoryEntry {
  readonly label: string;
  readonly state: HistoryState;
  readonly detail?: string;
}

/** W3-E2: single-line recent-task preview with colour-coded state. */
export function renderHistoryBar(entry: HistoryEntry | undefined, theme: UiTheme): string | undefined {
  if (!entry) return undefined;
  if (entry.state === "success") return `${theme.blue(theme.symbols.success)} ${entry.label}${entry.detail ? ` ${theme.dim(entry.detail)}` : ""}`;
  if (entry.state === "failure") return `${theme.red(theme.symbols.failure)} ${entry.label}${entry.detail ? ` ${theme.dim(entry.detail)}` : ""}`;
  if (entry.state === "timeout") return `${theme.red(theme.symbols.timeout)} ${entry.label}${entry.detail ? ` ${theme.dim(entry.detail)}` : ""}`;
  return `${theme.dim(theme.symbols.pending)} ${entry.label}${entry.detail ? ` ${theme.dim(entry.detail)}` : ""}`;
}
