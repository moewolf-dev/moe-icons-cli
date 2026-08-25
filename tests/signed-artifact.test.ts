import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadSignedArtifact, fetchSignedArtifactDescriptor } from "../src/core/signed-artifact.js";

const bytes = new TextEncoder().encode("artifact");
const sha = createHash("sha256").update(bytes).digest("hex");
const descriptor = { url: "https://signed.example/object", expiresAt: "2030-01-01T00:00:00Z", size: bytes.byteLength, sha256: sha };

describe("signed artifact privacy boundary", () => {
  it("sends Authorization only to the fixed API origin", async () => {
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://api.moeicons.com/v1/future-pro-endpoint");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(init?.redirect).toBe("error");
      return Response.json(descriptor);
    });
    await expect(fetchSignedArtifactDescriptor("/v1/future-pro-endpoint", "secret", { fetch: fetchFn as typeof fetch, now: 0 })).resolves.toEqual(descriptor);
    await expect(fetchSignedArtifactDescriptor("https://evil.example/x", "secret", { fetch: fetchFn as typeof fetch })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("downloads without Authorization/cookie and supports no Content-Length", async () => {
    const fetchFn = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      return new Response(bytes);
    });
    await expect(downloadSignedArtifact(descriptor, { allowedHosts: ["signed.example"], fetch: fetchFn as typeof fetch, now: 0 })).resolves.toEqual(bytes);
  });

  it("rejects untrusted redirects, expiry, size and checksum drift", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/object" } }));
    await expect(downloadSignedArtifact(descriptor, { allowedHosts: ["signed.example"], fetch: redirect as typeof fetch, now: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(downloadSignedArtifact({ ...descriptor, expiresAt: "1970-01-01T00:00:00Z" }, { allowedHosts: ["signed.example"], now: 1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const body = vi.fn(async () => new Response(bytes));
    await expect(downloadSignedArtifact({ ...descriptor, size: bytes.byteLength + 1 }, { allowedHosts: ["signed.example"], fetch: body as typeof fetch, now: 0 })).rejects.toThrow(/size mismatch/);
    await expect(downloadSignedArtifact({ ...descriptor, sha256: "f".repeat(64) }, { allowedHosts: ["signed.example"], fetch: body as typeof fetch, now: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("honours cancellation on the authenticated request", async () => {
    const controller = new AbortController(); controller.abort();
    const fetchFn = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => { if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError"); return Response.json(descriptor); });
    await expect(fetchSignedArtifactDescriptor("/v1/future", "secret", { fetch: fetchFn as typeof fetch, signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
