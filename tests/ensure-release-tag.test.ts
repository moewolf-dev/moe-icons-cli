import { describe, expect, it } from "vitest";
import { ensureReleaseTag } from "../scripts/ensure-release-tag.mjs";

const tag = "v0.0.21";
const commit = "a".repeat(40);
const token = "secret-token-value";

function response(status: number, body: unknown = "", requestId = "", acceptedPermissions = "") {
  return {
    status,
    headers: { get: (name: string) => {
      if (name === "x-github-request-id") return requestId;
      if (name === "x-accepted-github-permissions") return acceptedPermissions;
      return null;
    } },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
    clone() { return response(status, body, requestId, acceptedPermissions); },
  };
}

const base = (impl: (url: string, init?: { method?: string }) => unknown) =>
  ensureReleaseTag({ tag, commit, token, fetchImpl: impl as never });

describe("release tag diagnostics", () => {
  it("reports the GitHub message, documentation and request id on a 403", async () => {
    const calls: string[] = [];
    await expect(base((url, init?: { method?: string }) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.endsWith(`git/ref/tags/${tag}`)) return response(404);
      return response(403, { message: "Resource not accessible by integration", documentation_url: "https://docs.github.com/rest" }, "REQ-123", "contents=write");
    })).rejects.toThrow(/HTTP 403, request REQ-123.*Resource not accessible by integration.*docs\.github\.com.*accepted-permissions=contents=write.*tag=v0\.0\.21 commit=a{40}/);
    expect(calls.some((call) => call.startsWith("POST"))).toBe(true);
  });

  it("never echoes the token in the failure message", async () => {
    const error = await base(() => response(403, { message: "Resource not accessible by integration" })).catch((e) => e);
    expect(String(error.message)).not.toContain(token);
  });

  it("keeps the happy path unchanged", async () => {
    let call = 0;
    const result = await base(() => {
      call += 1;
      if (call === 1) return response(404);
      if (call === 2) return response(201, { ref: `refs/tags/${tag}` });
      return response(200, { ref: `refs/tags/${tag}`, object: { type: "commit", sha: commit } });
    });
    expect(result).toMatchObject({ status: "verified", tag, commit, created: true });
  });
});
