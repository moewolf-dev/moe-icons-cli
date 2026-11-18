import { describe, expect, it } from "vitest";
import {
  CLI_ERROR_EXIT_MAP,
  ERROR_PHASES,
  CliError,
  cliErrorJson,
  isErrorPhase,
  jsonErrorBody,
} from "../src/errors/errors.js";
import { redactText, redactUrl, redactValue } from "../src/errors/redact.js";

describe("REF-08 error context contract", () => {
  it("freezes the minimal phase enum", () => {
    expect(ERROR_PHASES).toEqual([
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
    ]);
    expect(isErrorPhase("download")).toBe(true);
    expect(isErrorPhase("random-extension")).toBe(false);
  });

  it("keeps the code/exit map unchanged", () => {
    expect(Object.keys(CLI_ERROR_EXIT_MAP)).toHaveLength(13);
    expect(new CliError("NETWORK_ERROR", "x").exitCode).toBe(3);
  });

  it("adds phase/hint/retryable/operationId only when supplied", () => {
    expect(cliErrorJson(new CliError("VALIDATION_ERROR", "bad"))).toEqual(
      jsonErrorBody("VALIDATION_ERROR", "bad"),
    );
    const rich = new CliError("NETWORK_ERROR", "offline", {
      phase: "download",
      hint: "check the proxy",
      retryable: true,
      operationId: "op_1234",
    });
    expect(cliErrorJson(rich)).toEqual({
      ok: false,
      code: "NETWORK_ERROR",
      message: "offline",
      phase: "download",
      hint: "check the proxy",
      retryable: true,
      operationId: "op_1234",
    });
  });

  it("carries already-redacted context without printing it", () => {
    const error = new CliError("DISK_FULL", "no space", {
      phase: "download",
      context: { phase: "download", code: "DISK_FULL" },
    });
    expect(error.context).toEqual({ phase: "download", code: "DISK_FULL" });
    expect(JSON.stringify(cliErrorJson(error))).not.toContain('DISK_FULL","context');
  });
});

describe("REF-08 redactor", () => {
  it("removes bearer tokens, JWTs, npm/GitHub tokens and private keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const text = redactText(
      `Authorization: Bearer abcdefghijklmnop rk=${jwt} npm_abcdefghijklmnopqrstuvwxyz ghp_abcdefghijklmnopqrstuvwxyz\n-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`,
    );
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain(jwt);
    expect(text).not.toContain("npm_");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("MIIE");
    expect(text).toContain("<redacted");
  });

  it("redacts emails and absolute home paths while keeping project-relative paths", () => {
    const text = redactText(
      "failed for buyer@example.com at /Users/alice/projects/app/node_modules/x and C:\\Users\\Bob\\app",
      { cwd: "/Users/alice/projects/app" },
    );
    expect(text).not.toContain("buyer@example.com");
    expect(text).not.toContain("/Users/alice");
    expect(text).not.toContain("C:\\Users\\Bob");
  });

  it("strips signed URL query values but keeps origin/path", () => {
    expect(
      redactUrl("https://signed.example/object?X-Amz-Signature=abc123&X-Amz-Credential=key"),
    ).toBe("https://signed.example/object?<redacted>");
  });

  it("recursively redacts sensitive keys and bounds the node budget", () => {
    const value = redactValue({
      email: "a@b.co",
      nested: { accessToken: "secret-value", note: "ok" },
      list: Array.from({ length: 100 }, () => "x"),
    }) as Record<string, unknown>;
    expect(value.email).toBe("<redacted>");
    expect((value.nested as Record<string, unknown>).accessToken).toBe("<redacted>");
    expect((value.list as unknown[]).length).toBe(50);
  });

  it("never throws on cyclic or exotic input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).not.toThrow();
    expect(redactText(String(Symbol("x")))).toContain("Symbol");
  });
});
