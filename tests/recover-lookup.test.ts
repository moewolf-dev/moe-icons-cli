import { describe, expect, it } from "vitest";
import { lookupOrAbsent } from "../scripts/recover-candidate.mjs";

const lookup = (results: Array<{ ok: boolean; stdout?: string; stderr?: string }>) => {
  let i = 0;
  return lookupOrAbsent({ label: "tag v0.0.21", args: [], run: () => results[Math.min(i++, results.length - 1)]! });
};

describe("recovery lookup classification", () => {
  it("treats an explicit 404 as absent", () => {
    expect(lookup([{ ok: false, stderr: "gh: Not Found (HTTP 404)" }])).toEqual({ exists: false });
  });

  it("returns the parsed object when the lookup succeeds", () => {
    expect(lookup([{ ok: true, stdout: '{"object":{"sha":"a"}}' }])).toEqual({ exists: true, value: { object: { sha: "a" } } });
  });

  it("aborts on a permission error instead of treating it as absent", () => {
    expect(() => lookup([{ ok: false, stderr: "HTTP 403: Resource not accessible by integration" }]))
      .toThrow(/denied the lookup/);
  });

  it("retries transient failures and then succeeds", () => {
    expect(lookup([{ ok: false, stderr: "HTTP 503" }, { ok: true, stdout: '{"ok":true}' }]))
      .toEqual({ exists: true, value: { ok: true } });
  });

  it("aborts when transient retries are exhausted", () => {
    expect(() => lookup([{ ok: false, stderr: "ECONNRESET" }])).toThrow(/lookup failed after 3 attempts/);
  });

  it("aborts on an unparsable success payload", () => {
    expect(() => lookup([{ ok: true, stdout: "not json" }])).toThrow();
  });
});
