/**
 * Stable error codes and exit-code mapping. CLI processes use exit codes:
 * 0 success/cancel, 1 validation error, 2 auth error, 3 network error,
 * 4 not found, 5 unexpected.
 */

export type CliErrorCode =
  | "HELP"
  | "VERSION"
  | "CANCELLED"
  | "VALIDATION_ERROR"
  | "TAILWIND_VERSION_UNSUPPORTED"
  | "AUTH_ERROR"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "NOT_TTY"
  | "NOT_IMPLEMENTED"
  | "DISK_FULL"
  | "UNEXPECTED";

/** Frozen CliErrorCode → process exit code. Register new codes here before use. */
export const CLI_ERROR_EXIT_MAP = {
  HELP: 0,
  VERSION: 0,
  CANCELLED: 0,
  VALIDATION_ERROR: 1,
  TAILWIND_VERSION_UNSUPPORTED: 1,
  NOT_TTY: 1,
  NOT_IMPLEMENTED: 1,
  AUTH_ERROR: 2,
  FORBIDDEN: 2,
  NETWORK_ERROR: 3,
  NOT_FOUND: 4,
  DISK_FULL: 5,
  UNEXPECTED: 5,
} as const satisfies Record<CliErrorCode, number>;

/**
 * P1-06 / REF-08: the frozen minimal error-phase set. Business layers may only
 * use one of these; adding a phase requires registering it here and adding a
 * contract test (see tests/errors-phase.test.ts).
 */
export const ERROR_PHASES = [
  "startup",
  "parse",
  "preflight",
  "config",
  "project",
  "auth",
  "network",
  "download",
  "verify",
  "extract",
  "install",
  "update",
  "diagnostic",
] as const;

export type ErrorPhase = (typeof ERROR_PHASES)[number];

export function isErrorPhase(value: unknown): value is ErrorPhase {
  return typeof value === "string" && (ERROR_PHASES as readonly string[]).includes(value);
}

export type JsonErrorBody = {
  readonly ok: false;
  readonly code: CliErrorCode;
  readonly message: string;
  readonly phase?: ErrorPhase;
  readonly retryable?: boolean;
  readonly hint?: string;
  readonly operationId?: string;
};

export interface CliErrorOptions {
  readonly phase?: ErrorPhase;
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly operationId?: string;
  /** Structured, already-redacted context for diagnostics (never printed raw). */
  readonly context?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly phase?: ErrorPhase;
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly operationId?: string;
  readonly context?: Readonly<Record<string, string | number | boolean | undefined>>;

  constructor(code: CliErrorCode, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCodeFor(code);
    if (options.phase !== undefined) this.phase = options.phase;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.operationId !== undefined) this.operationId = options.operationId;
    if (options.context !== undefined) this.context = options.context;
  }
}

export function exitCodeFor(code: CliErrorCode): number {
  return CLI_ERROR_EXIT_MAP[code];
}

export function jsonErrorBody(code: CliErrorCode, message: string): JsonErrorBody {
  return { ok: false, code, message };
}

/** Add the optional REF-08 fields without breaking `ok/code/message` consumers. */
export function cliErrorJson(error: CliError, operationId?: string): JsonErrorBody {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.phase ? { phase: error.phase } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.hint ? { hint: error.hint } : {}),
    ...((error.operationId ?? operationId) !== undefined
      ? { operationId: (error.operationId ?? operationId) as string }
      : {}),
  };
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}
