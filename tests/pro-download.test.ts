import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { downloadProArtifact, resolveProDescriptorEndpoint } from "../src/core/pro-download.js";
import type { StoredSession, TokenStore } from "../src/auth/token-store.js";
import type { CommandContext } from "../src/core/context.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";

const descriptorSha = "a".repeat(64);
function store(initial: StoredSession): TokenStore { let value: StoredSession | undefined = initial; return { get: () => value, getActive: () => value, set: (next) => { value = next; }, delete: () => { value = undefined; }, clear: () => { value = undefined; } }; }
function context(dir: string, env: Record<string, string> = {}): CommandContext { return { cwd: dir, env, signal: new AbortController().signal, now: () => new Date("2026-08-24T00:00:00Z"), ui: { select: async () => undefined, confirm: async () => true, text: async () => undefined, note() {}, progress: () => ({ stop() {} }) } }; }
const session: StoredSession = { accountId: "a", accessToken: "old-access", refreshToken: "refresh", expiresAt: Date.parse("2026-08-24T01:00:00Z"), scope: "openid", storedAt: 1 };

describe("pro signed download", () => {
  let release: string; let archive: Uint8Array; let metadataArchive: Uint8Array; let meta: ReturnType<typeof writeFreeReleaseFixture>;
  beforeEach(() => {
    release = mkdtempSync(join(tmpdir(), "pro-download-"));
    meta = writeFreeReleaseFixture(release, { tier: "pro" });
    archive = new Uint8Array(readFileSync(join(release, meta.freeName)));
    metadataArchive = new Uint8Array(readFileSync(join(release, meta.metadataName)));
  });
  afterEach(() => rmSync(release, { recursive: true, force: true }));

  function body() {
    return {
      ok: true, tier: "pro", version: meta.version, descriptorSha256: descriptorSha,
      catalogFilename: "catalog.json", catalogSha256: meta.catalogSha,
      url: "https://signed.example/object", expiresAt: "2026-08-24T00:02:00Z",
      size: archive.byteLength, sha256: meta.freeSha,
      metadata: { url: "https://signed.example/meta", expiresAt: "2026-08-24T00:02:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha },
    };
  }

  function signedResponse(url: string) {
    return url.includes("/meta") ? new Response(metadataArchive) : new Response(archive);
  }

  it("downloads exact bytes and never forwards API credentials to the signed host", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input); calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return url.includes("artifact-descriptor") ? Response.json(body()) : signedResponse(url);
    });
    const result = await downloadProArtifact(context(release), { tokenStore: store(session) }, { version: meta.version, descriptorSha256: descriptorSha }, { fetch: fetchFn as typeof fetch, allowedHosts: ["signed.example"] });
    expect(result.catalogJson.length).toBeGreaterThan(0);
    expect(result.manifestJson).toContain('"tier": "pro"');
    expect(calls[0]?.authorization).toBe("Bearer old-access");
    expect(calls.slice(1).every((call) => call.authorization === null)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("refresh");
  });

  it("refreshes exactly once on 401 and maps 403 without downloading", async () => {
    const tokenStore = store(session); let apiCalls = 0; let refreshCalls = 0;
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth/token")) { refreshCalls += 1; return Response.json({ access_token: "new-access", expires_in: 60 }); }
      if (url.includes("artifact-descriptor")) { apiCalls += 1; if (apiCalls === 1) return Response.json({}, { status: 401 }); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new-access"); return Response.json(body()); }
      return signedResponse(url);
    });
    const env = { MOEICONS_AUTH0_ISSUER: "https://tenant.auth0.com", MOEICONS_AUTH0_CLIENT_ID: "client" };
    await downloadProArtifact(context(release, env), { tokenStore, fetch: fetchFn as typeof fetch }, { version: meta.version, descriptorSha256: descriptorSha }, { fetch: fetchFn as typeof fetch, allowedHosts: ["signed.example"] });
    expect(apiCalls).toBe(2); expect(refreshCalls).toBe(1);
    const forbidden = vi.fn(async () => Response.json({}, { status: 403 }));
    await expect(downloadProArtifact(context(release), { tokenStore: store(session) }, { version: meta.version, descriptorSha256: descriptorSha }, { fetch: forbidden as typeof fetch, allowedHosts: ["signed.example"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-loopback, non-https MOEICONS_PRO_DESCRIPTOR_URL override", () => {
    expect(() =>
      resolveProDescriptorEndpoint({ MOEICONS_PRO_DESCRIPTOR_URL: "http://evil.example.com/x" }),
    ).toThrow(/loopback|https/);
    expect(resolveProDescriptorEndpoint({}).url).toContain("api.moeicons.com");
    expect(resolveProDescriptorEndpoint({ MOEICONS_PRO_DESCRIPTOR_URL: "https://api.moeicons.com/x" }).allowLoopback).toBe(false);
    expect(resolveProDescriptorEndpoint({ MOEICONS_PRO_DESCRIPTOR_URL: "http://127.0.0.1:9999/x" }).allowLoopback).toBe(true);
  });

  it("downloads pro code + metadata through a loopback mock endpoint (candidate acceptance)", async () => {
    let port = 0;
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.endsWith("/artifact-descriptor")) {
        let body = "";
        request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        request.on("end", () => {
          const expected = JSON.parse(body) as { version: string; descriptorSha256: string };
          if (expected.version !== meta.version || expected.descriptorSha256 !== descriptorSha) {
            response.writeHead(403).end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            ok: true, tier: "pro", version: meta.version, descriptorSha256: descriptorSha,
            catalogFilename: "catalog.json", catalogSha256: meta.catalogSha,
            url: `http://127.0.0.1:${port}/pro.tgz`, expiresAt: "2099-01-01T00:00:00Z",
            size: archive.byteLength, sha256: meta.freeSha,
            metadata: { url: `http://127.0.0.1:${port}/pro-meta.tgz`, expiresAt: "2099-01-01T00:00:00Z", size: metadataArchive.byteLength, sha256: meta.metadataSha },
          }));
        });
        return;
      }
      if (url.pathname.endsWith("/pro-meta.tgz")) {
        response.writeHead(200, { "content-length": metadataArchive.byteLength });
        response.end(metadataArchive);
        return;
      }
      if (url.pathname.endsWith("/pro.tgz")) {
        response.writeHead(200, { "content-length": archive.byteLength });
        response.end(archive);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    try {
      const endpoint = `http://127.0.0.1:${port}/v1/icon-library/pro/artifact-descriptor`;
      const env = { MOEICONS_PRO_DESCRIPTOR_URL: endpoint };
      const result = await downloadProArtifact(
        context(release, env),
        { tokenStore: store(session) },
        { version: meta.version, descriptorSha256: descriptorSha },
        {},
      );
      expect(result.manifestJson).toContain('"tier": "pro"');
      expect(result.manualMd.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});
