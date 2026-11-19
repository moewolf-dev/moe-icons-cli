/**
 * P1-06 / REF-08: bounded, redacted, in-process diagnostics.
 *
 * The default run keeps only transient information (one error + optional hint
 * on stderr). A process-wide ring buffer holds at most 200 events / ~256 KiB
 * and is destroyed on exit. `--debug` mirrors the same redacted stream to
 * stderr. Nothing here writes a file, uploads telemetry or changes the exit
 * code; sink failures only append one `DIAGNOSTIC_WRITE_FAILED` warning.
 */

import { randomBytes } from "node:crypto";
import type { ErrorPhase } from "../errors/errors.js";
import { redactText, type RedactOptions } from "../errors/redact.js";

export const RING_BUFFER_MAX_EVENTS = 200;
export const RING_BUFFER_MAX_BYTES = 256 * 1024;

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticEvent {
  readonly at: string;
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly phase?: ErrorPhase;
  readonly code?: string;
  readonly operationId?: string;
  readonly attempt?: number;
  /** Safe scalar context; keys/values are redacted by the recorder. */
  readonly context?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface DiagnosticClock {
  readonly now: () => Date;
}

export interface DiagnosticSink {
  readonly write: (event: DiagnosticEvent) => void;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Fixed-capacity ring buffer with both an event-count and a byte budget. */
export class DiagnosticRingBuffer {
  private readonly events: DiagnosticEvent[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(
    private readonly maxEvents = RING_BUFFER_MAX_EVENTS,
    private readonly maxBytes = RING_BUFFER_MAX_BYTES,
  ) {}

  push(event: DiagnosticEvent): void {
    const size = byteLength(JSON.stringify(event));
    this.events.push(event);
    this.bytes += size;
    while (
      this.events.length > this.maxEvents ||
      (this.bytes > this.maxBytes && this.events.length > 1)
    ) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= byteLength(JSON.stringify(removed));
      this.dropped += 1;
    }
  }

  snapshot(limit = this.events.length): readonly DiagnosticEvent[] {
    return this.events.slice(Math.max(0, this.events.length - Math.max(0, limit)));
  }

  get size(): number {
    return this.events.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get byteSize(): number {
    return this.bytes;
  }

  clear(): void {
    this.events.length = 0;
    this.bytes = 0;
    this.dropped = 0;
  }
}

export interface DiagnosticRecorderOptions {
  readonly debug?: boolean;
  readonly stderr?: (text: string) => void;
  readonly clock?: DiagnosticClock;
  readonly redact?: RedactOptions;
  readonly ring?: DiagnosticRingBuffer;
  /** Extra injectable sinks (tests) beyond the optional stderr mirror. */
  readonly sinks?: readonly DiagnosticSink[];
}

/** Creates a deterministic short operation id (no PII, no timestamps). */
export function createOperationId(
  random: () => string = () => randomBytes(4).toString("hex"),
): string {
  return `op_${random()}`;
}

export class DiagnosticRecorder {
  readonly ring: DiagnosticRingBuffer;
  private readonly sinks: DiagnosticSink[] = [];
  private readonly clock: DiagnosticClock;
  private readonly redactOptions: RedactOptions;

  constructor(options: DiagnosticRecorderOptions = {}) {
    this.ring = options.ring ?? new DiagnosticRingBuffer();
    this.clock = options.clock ?? { now: () => new Date() };
    this.redactOptions = options.redact ?? {};
    this.sinks.push(...(options.sinks ?? []));
    if (options.debug && options.stderr) {
      const write = options.stderr;
      this.sinks.push({
        write: (event) => {
          const phase = event.phase ? ` phase=${event.phase}` : "";
          const code = event.code ? ` code=${event.code}` : "";
          const operation = event.operationId ? ` op=${event.operationId}` : "";
          const attempt = event.attempt !== undefined ? ` attempt=${event.attempt}` : "";
          write(
            `debug [${event.level}] ${event.message}${phase}${code}${operation}${attempt}${event.context ? ` ${formatContext(event.context, this.redactOptions)}` : ""}\n`,
          );
        },
      });
    }
  }

  /**
   * Record one event. Sink failures are isolated: they never throw into the
   * caller and never replace the original business error.
   */
  record(event: Omit<DiagnosticEvent, "at"> & { readonly at?: string }): DiagnosticEvent {
    const safe: DiagnosticEvent = {
      at: event.at ?? this.clock.now().toISOString(),
      level: event.level,
      message: redactText(event.message, this.redactOptions).slice(0, 4_000),
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.code ? { code: event.code } : {}),
      ...(event.operationId ? { operationId: event.operationId } : {}),
      ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      ...(event.context ? { context: redactContext(event.context, this.redactOptions) } : {}),
    };
    // Ring-buffer insertion itself must never break the business path.
    try {
      this.ring.push(safe);
    } catch {
      /* A ring-buffer failure is non-fatal by contract. */
    }
    for (const sink of this.sinks) {
      try {
        sink.write(safe);
      } catch {
        try {
          this.ring.push({
            at: this.clock.now().toISOString(),
            level: "warn",
            code: "DIAGNOSTIC_WRITE_FAILED",
            message: "diagnostic sink failed; the original operation result is unchanged",
          });
        } catch {
          /* Never escalate. */
        }
      }
    }
    return safe;
  }

  lastEvents(limit = 20): readonly DiagnosticEvent[] {
    return this.ring.snapshot(limit);
  }
}

function redactContext(
  context: Readonly<Record<string, string | number | boolean | undefined>>,
  options: RedactOptions,
): Record<string, string | number | boolean | undefined> {
  const result: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(context).slice(0, 30)) {
    if (value === undefined) continue;
    result[key] = typeof value === "string" ? redactText(value, options).slice(0, 500) : value;
  }
  return result;
}

function formatContext(
  context: Readonly<Record<string, string | number | boolean | undefined>>,
  options: RedactOptions,
): string {
  return Object.entries(redactContext(context, options))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

/**
 * Runtime-scoped recorder lookup. A CLI process has one recorder; tests get a
 * fresh one per runtime object so no ring state leaks between tests.
 */
const recorders = new WeakMap<object, DiagnosticRecorder>();

export function diagnosticsFor(
  owner: object,
  options: DiagnosticRecorderOptions = {},
): DiagnosticRecorder {
  const existing = recorders.get(owner);
  if (existing) return existing;
  const created = new DiagnosticRecorder(options);
  recorders.set(owner, created);
  return created;
}

export function resetDiagnosticsFor(owner: object): void {
  recorders.delete(owner);
}
