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
  UNEXPECTED: 5,
} as const satisfies Record<CliErrorCode, number>;

export type JsonErrorBody = {
  readonly ok: false;
  readonly code: CliErrorCode;
  readonly message: string;
};

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCodeFor(code);
  }
}

export function exitCodeFor(code: CliErrorCode): number {
  return CLI_ERROR_EXIT_MAP[code];
}

export function jsonErrorBody(code: CliErrorCode, message: string): JsonErrorBody {
  return { ok: false, code, message };
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}
