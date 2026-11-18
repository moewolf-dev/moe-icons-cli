/**
 * REF-03: a single owner for live terminal dimensions and for throttled
 * repainting. The provider reads the current width at paint time (never caches a
 * startup width) and registers a resize listener only while dynamic UI is
 * alive.
 */

import type { TerminalCapabilities } from "./capabilities.js";

export { resolveColumns, normalizeColumns } from "./capabilities.js";

export interface ResizeSource {
  on(event: "resize", listener: () => void): unknown;
  removeListener(event: "resize", listener: () => void): unknown;
}

export interface TerminalDimensions {
  columns(): number;
  rows(): number | undefined;
  /** Subscribe to resize events. Returns an unsubscribe function. */
  onResize(listener: (columns: number) => void): () => void;
  dispose(): void;
}

export interface DimensionsOptions {
  readonly columns?: () => number | undefined;
  readonly rows?: () => number | undefined;
  readonly stdout?: ResizeSource | undefined;
  readonly fallbackColumns?: number;
}

export function createTerminalDimensions(options: DimensionsOptions = {}): TerminalDimensions {
  const fallback = options.fallbackColumns ?? 80;
  const listeners = new Set<(columns: number) => void>();
  let subscribed = false;
  const emit = () => {
    const columns = dimensions.columns();
    for (const listener of [...listeners]) {
      try {
        listener(columns);
      } catch {
        /* A renderer failure cannot break terminal bookkeeping. */
      }
    }
  };
  const dimensions: TerminalDimensions = {
    columns() {
      const raw = options.columns?.();
      if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return fallback;
      return Math.floor(raw);
    },
    rows() {
      const raw = options.rows?.();
      return raw !== undefined && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
    },
    onResize(listener) {
      listeners.add(listener);
      if (!subscribed && options.stdout) {
        try {
          options.stdout.on("resize", emit);
          subscribed = true;
        } catch {
          /* Resize is best-effort (Windows terminals may not emit it). */
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && subscribed && options.stdout) {
          try {
            options.stdout.removeListener("resize", emit);
          } catch {
            /* ignore */
          }
          subscribed = false;
        }
      };
    },
    dispose() {
      listeners.clear();
      if (subscribed && options.stdout) {
        try {
          options.stdout.removeListener("resize", emit);
        } catch {
          /* ignore */
        }
        subscribed = false;
      }
    },
  };
  return dimensions;
}

/** A dimensions provider for a fixed capability snapshot (tests/static mode). */
export function staticDimensions(columns: number): TerminalDimensions {
  return createTerminalDimensions({ columns: () => columns, fallbackColumns: columns });
}

export interface ThrottledPainterOptions {
  /** Minimum interval between paints. */
  readonly intervalMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

export interface ThrottledPainter<T> {
  readonly update: (value: T) => void;
  /** Paint the latest value immediately and clear timers. */
  readonly flush: () => void;
  readonly dispose: () => void;
  readonly paints: number;
}

/**
 * Coalesce high-frequency progress ticks: at most one paint per interval, and a
 * forced final paint on flush/stop. The terminal has exactly one dynamic
 * renderer, so concurrent spinners cannot overwrite each other.
 */
export function createThrottledPainter<T>(
  paint: (value: T) => void,
  options: ThrottledPainterOptions = {},
): ThrottledPainter<T> {
  const interval = Math.max(0, options.intervalMs ?? 80);
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel =
    options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let latest: T | undefined;
  let lastPaint = -Infinity;
  let timer: unknown;
  let disposed = false;
  let paints = 0;

  const run = () => {
    timer = undefined;
    if (disposed || latest === undefined) return;
    lastPaint = now();
    const value = latest;
    paints += 1;
    try {
      paint(value);
    } catch {
      /* Rendering failures are isolated from the task result. */
    }
  };

  return {
    update(value) {
      if (disposed) return;
      latest = value;
      const elapsed = now() - lastPaint;
      if (elapsed >= interval) {
        if (timer !== undefined) {
          cancel(timer);
          timer = undefined;
        }
        run();
        return;
      }
      if (timer !== undefined) return;
      timer = schedule(run, interval - elapsed);
    },
    flush() {
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      run();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      latest = undefined;
    },
    get paints() {
      return paints;
    },
  };
}

/** Width-aware text fitting used by prompts and status lines. */
export function fitLine(value: string, columns: number, ellipsis = "…"): string {
  if (columns <= 0) return value;
  // Imported lazily to avoid a cycle with banner.ts (which owns width helpers).
  const width = (text: string): number => {
    let total = 0;
    const segmenter =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : undefined;
    const parts = segmenter ? [...segmenter.segment(text)].map((part) => part.segment) : [...text];
    for (const part of parts) {
      const point = [...part][0] ?? "";
      total += isWide(point) ? 2 : /[\p{Mark}\p{Cc}\p{Cf}]/u.test(point) ? 0 : 1;
    }
    return total;
  };
  if (width(value) <= columns) return value;
  const budget = Math.max(0, columns - 1);
  let result = "";
  let used = 0;
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : undefined;
  const parts = segmenter ? [...segmenter.segment(value)].map((part) => part.segment) : [...value];
  for (const part of parts) {
    const point = [...part][0] ?? "";
    const size = isWide(point) ? 2 : /[\p{Mark}\p{Cc}\p{Cf}]/u.test(point) ? 0 : 1;
    if (used + size > budget) break;
    result += part;
    used += size;
  }
  return `${result}${ellipsis}`;
}

function isWide(point: string): boolean {
  return (
    /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(
      point,
    ) || /\p{Extended_Pictographic}/u.test(point)
  );
}

/** Capability-aware notice width: never narrower than 20, never wider than the screen. */
export function noticeWidth(capabilities: TerminalCapabilities): number {
  return Math.max(20, capabilities.columns ?? 80);
}
