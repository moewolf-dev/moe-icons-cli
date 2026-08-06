import { describe, it, expect } from "vitest";
import { downloadArtifact, verifyArtifact, extractArtifact, createArtifactZip } from "../src/project/install.js";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";

const GOOD_ZIP = createArtifactZip({ "a.txt": "hello" });

function okResponse(body: Uint8Array, status = 200) {
  return new Response(body, { status });
}

describe("downloadArtifact", () => {
  it("downloads an https artifact within limits", async () => {
    const result = await downloadArtifact("https://cdn.example.com/g.zip", {
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 3,
    }, {
      fetchFn: async () => okResponse(GOOD_ZIP),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toEqual(GOOD_ZIP);
  });

  it("rejects non-https urls", async () => {
    const result = await downloadArtifact("http://cdn.example.com/g.zip", {
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NON_HTTPS");
  });

  it("rejects hosts outside the allowlist", async () => {
    const result = await downloadArtifact("https://evil.example.com/g.zip", {
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 3,
      allowedHosts: ["cdn.example.com"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HOST_NOT_ALLOWED");
  });

  it("follows bounded redirects and rejects too many", async () => {
    const fetchFn = async (url: string) => {
      if (url === "https://cdn.example.com/start") {
        return new Response(null, { status: 302, headers: { location: "https://cdn.example.com/g.zip" } });
      }
      return okResponse(GOOD_ZIP);
    };
    const result = await downloadArtifact("https://cdn.example.com/start", {
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 1,
    }, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(result.ok).toBe(true);

    const loopFn = async () =>
      new Response(null, { status: 302, headers: { location: "https://cdn.example.com/loop" } });
    const loop = await downloadArtifact("https://cdn.example.com/loop", {
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 1,
    }, { fetchFn: loopFn as unknown as typeof fetch });
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.code).toBe("TOO_MANY_REDIRECTS");
  });

  it("rejects oversized bodies", async () => {
    const result = await downloadArtifact("https://cdn.example.com/big.zip", {
      maxBytes: 10,
      timeoutMs: 5000,
      maxRedirects: 3,
    }, { fetchFn: async () => okResponse(GOOD_ZIP) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_LARGE");
  });

  it("maps network errors", async () => {
    const result = await downloadArtifact("https://cdn.example.com/g.zip", {
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 3,
    }, {
      fetchFn: async () => {
        throw new Error("connection refused");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NETWORK_ERROR");
  });
});

describe("verifyArtifact", () => {
  it("matches expected sha256", () => {
    const expected = createHash("sha256").update(GOOD_ZIP).digest("hex");
    const result = verifyArtifact(GOOD_ZIP, expected);
    expect(result.ok).toBe(true);
  });

  it("reports a mismatch without throwing", () => {
    const result = verifyArtifact(GOOD_ZIP, "f".repeat(64));
    expect(result.ok).toBe(false);
    expect(result.actual).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extractArtifact", () => {
  it("extracts and rejects unsafe paths", () => {
    const safe = extractArtifact(GOOD_ZIP, { maxEntries: 10, maxExpandedBytes: 1024 });
    expect(safe.errors).toEqual([]);
    expect(safe.files["a.txt"]).toBe("hello");

    const evil = zipSync({ "../escape.txt": strToU8("x") });
    const result = extractArtifact(evil, { maxEntries: 10, maxExpandedBytes: 1024 });
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
