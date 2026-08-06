/**
 * Stable error codes and exit-code mapping. CLI processes use exit codes:
 * 0 success/cancel, 1 validation error, 2 auth error, 3 network error,
 * 4 unexpected error.
 */

export type CliErrorCode =
  | "HELP"
  | "VERSION"
  | "CANCELLED"
  | "VALIDATION_ERROR"
  | "AUTH_ERROR"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "NOT_TTY"
  | "UNEXPECTED";

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
  switch (code) {
    case "HELP":
    case "VERSION":
    case "CANCELLED":
      return 0;
    case "VALIDATION_ERROR":
    case "NOT_TTY":
      return 1;
    case "AUTH_ERROR":
    case "FORBIDDEN":
      return 2;
    case "NETWORK_ERROR":
      return 3;
    case "NOT_FOUND":
      return 4;
    case "UNEXPECTED":
    default:
      return 5;
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}
