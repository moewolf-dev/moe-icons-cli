import { describe, expect, it } from "vitest";
import { CLI_ERROR_EXIT_MAP, CliError, jsonErrorBody } from "../src/errors/index.js";

describe("CLI error exit map", () => {
  it("freezes CliErrorCode to exit code including Tailwind reservation", () => {
    expect(CLI_ERROR_EXIT_MAP).toEqual({
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
    });
    expect(new CliError("NOT_FOUND", "missing").exitCode).toBe(4);
    expect(new CliError("UNEXPECTED", "boom").exitCode).toBe(5);
    expect(new CliError("TAILWIND_VERSION_UNSUPPORTED", "tailwind").exitCode).toBe(
      CLI_ERROR_EXIT_MAP.VALIDATION_ERROR,
    );
  });

  it("builds the machine-readable error body", () => {
    expect(jsonErrorBody("NOT_IMPLEMENTED", "login is not implemented yet")).toEqual({
      ok: false,
      code: "NOT_IMPLEMENTED",
      message: "login is not implemented yet",
    });
  });
});
