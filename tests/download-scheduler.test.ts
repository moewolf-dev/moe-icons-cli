import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cleanupDownloadTempDirsSync, downloadArtifactToFile } from "../src/project/download.js";
import {
  createDownloadScheduler,
  MAX_PACKAGE_CONCURRENCY,
} from "../src/project/download-scheduler.js";
import { parseRetryAfter, retryDelayMs } from "../src/project/retry-policy.js";

const BODY = Buffer.from("streamed-payload");
const SHA = createHash("sha256").update(BODY).digest("hex");

let server: Server;
let origin: string;
let active = 0;
let peak = 0;
let retries = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/object" });
      response.end();
      return;
    }
    if (url.pathname === "/retry") {
      retries += 1;
      if (retries === 1) {
        response.writeHead(429, { "retry-after": "0" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-length": String(BODY.byteLength) });
      response.end(BODY);
      return;
    }
    if (url.pathname === "/slow") {
      const timeout = setTimeout(() => {
        response.writeHead(200);
        response.end(BODY);
      }, 60);
      request.on("close", () => clearTimeout(timeout));
      return;
    }
    if (url.pathname === "/stall") {
      response.writeHead(200, { "content-length": String(BODY.byteLength) });
      response.write("x");
      // Never finish; the watchdog must abort.
      return;
    }
    active += 1;
    peak = Math.max(peak, active);
    const timeout = setTimeout(() => {
      response.writeHead(200, { "content-length": String(BODY.byteLength) });
      response.end(BODY, () => {
        active -= 1;
      });
    }, 15);
    request.on("close", () => {
      clearTimeout(timeout);
      active -= 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  cleanupDownloadTempDirsSync();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const limits = () => ({
  maxBytes: 1024,
  timeoutMs: 5_000,
  maxRedirects: 2,
  allowedHosts: [new URL(origin).host],
  allowHttpLoopback: true,
});

describe("download to verified file (REF-04)", () => {
  it("streams a body to a file with incremental sha, then cleans up", async () => {
    const result = await downloadArtifactToFile(`${origin}/object`, limits());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.sha256).toBe(SHA);
    expect(result.file.size).toBe(BODY.byteLength);
    expect(await readFile(result.file.path)).toEqual(BODY);
    const directory = result.file.path.replace(/\/payload$/, "");
    expect((await stat(directory)).isDirectory()).toBe(true);
    await result.file.cleanup();
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await result.file.cleanup(); // idempotent
  });

  it("follows a bounded redirect and records the final URL", async () => {
    const result = await downloadArtifactToFile(`${origin}/redirect`, limits());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.finalUrl).toBe(`${origin}/object`);
    await result.file.cleanup();
  });

  it("retries a 429 with Retry-After without holding a slot", async () => {
    retries = 0;
    const scheduler = createDownloadScheduler({ packageConcurrency: 1 });
    const result = await downloadArtifactToFile(`${origin}/retry`, {
      ...limits(),
      scheduler,
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(scheduler.stats().packagePeak).toBe(1);
    if (result.ok) await result.file.cleanup();
  });

  it("aborts a stalled body at the watchdog and leaves no file", async () => {
    const result = await downloadArtifactToFile(`${origin}/stall`, {
      ...limits(),
      stallTimeoutMs: 40,
      maxAttempts: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NETWORK_ERROR");
    expect(result.message).toMatch(/stalled/);
  });

  it("links external cancellation to CANCELLED and cleans partial data", async () => {
    const controller = new AbortController();
    const pending = downloadArtifactToFile(
      `${origin}/slow`,
      { ...limits(), stallTimeoutMs: 0 },
      { signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["CANCELLED", "NETWORK_ERROR"]).toContain(result.code);
  });

  it("fails closed on a truncated body with a declared Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BODY.subarray(0, 4));
        controller.close();
      },
    });
    const result = await downloadArtifactToFile(
      "https://signed.example/object",
      {
        maxBytes: 1024,
        timeoutMs: 5_000,
        maxRedirects: 0,
        allowedHosts: ["signed.example"],
        maxAttempts: 1,
      },
      {
        fetchFn: (async () =>
          new Response(body, {
            status: 200,
            headers: { "content-length": String(BODY.byteLength) },
          })) as typeof fetch,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NETWORK_ERROR");
      expect(result.message).toMatch(/truncated response/);
    }
  });

  it("classifies DNS and TLS failures without retrying certificates", async () => {
    const dns = await downloadArtifactToFile(
      "https://signed.example/object",
      {
        maxBytes: 1024,
        timeoutMs: 5_000,
        maxRedirects: 0,
        allowedHosts: ["signed.example"],
        maxAttempts: 1,
      },
      {
        fetchFn: (async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND signed.example"), {
            code: "ENOTFOUND",
          });
        }) as typeof fetch,
      },
    );
    expect(dns.ok).toBe(false);
    if (!dns.ok) expect(dns.message).toMatch(/DNS lookup failed/);

    const tls = await downloadArtifactToFile(
      "https://signed.example/object",
      {
        maxBytes: 1024,
        timeoutMs: 5_000,
        maxRedirects: 0,
        allowedHosts: ["signed.example"],
        maxAttempts: 3,
      },
      {
        fetchFn: (async () => {
          throw new Error("self-signed certificate in certificate chain");
        }) as typeof fetch,
      },
    );
    expect(tls.ok).toBe(false);
    if (!tls.ok) {
      expect(tls.message).toMatch(/TLS verification failed/);
      expect(tls.attempts).toBe(1);
    }
  });

  it("reports a read-only staging directory as a non-retryable IO error", async () => {
    const staging = await mkdtemp(join(tmpdir(), "moeicons-readonly-"));
    await chmod(staging, 0o500);
    try {
      const result = await downloadArtifactToFile(
        "https://signed.example/object",
        {
          maxBytes: 1024,
          timeoutMs: 5_000,
          maxRedirects: 0,
          allowedHosts: ["signed.example"],
          maxAttempts: 1,
          tempDir: staging,
        },
        {
          fetchFn: (async () => new Response(BODY)) as typeof fetch,
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("IO_ERROR");
        expect(result.attempts).toBe(1);
      }
    } finally {
      await chmod(staging, 0o700);
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("rejects a body above the byte limit", async () => {
    const result = await downloadArtifactToFile(`${origin}/object`, {
      ...limits(),
      maxBytes: 4,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_LARGE");
  });
});

describe("shared scheduler (REF-05 / P0-03)", () => {
  it("never exceeds the frozen package ceiling and starts the next item immediately", async () => {
    const scheduler = createDownloadScheduler({ packageConcurrency: 9 });
    active = 0;
    peak = 0;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        downloadArtifactToFile(`${origin}/object?n=${index}`, {
          ...limits(),
          scheduler,
          maxAttempts: 1,
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    for (const result of results) if (result.ok) await result.file.cleanup();
    const stats = scheduler.stats();
    expect(stats.packagePeak).toBeLessThanOrEqual(MAX_PACKAGE_CONCURRENCY);
    expect(stats.packagePeak).toBeGreaterThan(1);
    expect(stats.packageActive).toBe(0);
    expect(stats.packageQueued).toBe(0);
  });

  it("drains a 10,000-item queue with a hard ceiling of 3", async () => {
    const scheduler = createDownloadScheduler({ packageConcurrency: 3 });
    let inFlight = 0;
    let observedPeak = 0;
    const tasks = Array.from({ length: 10_000 }, () =>
      scheduler.run("package", async () => {
        inFlight += 1;
        observedPeak = Math.max(observedPeak, inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(observedPeak).toBeLessThanOrEqual(3);
    expect(scheduler.stats().packagePeak).toBeLessThanOrEqual(3);
    expect(scheduler.stats().packageQueued).toBe(0);
    expect(scheduler.stats().completed).toBe(10_000);
  });

  it("keeps metadata slots independent from package slots", async () => {
    const scheduler = createDownloadScheduler({ packageConcurrency: 1, metadataConcurrency: 2 });
    let metadataPeak = 0;
    let packagePeak = 0;
    let metadata = 0;
    let packages = 0;
    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        scheduler.run("metadata", async () => {
          metadata += 1;
          metadataPeak = Math.max(metadataPeak, metadata);
          await new Promise((resolve) => setTimeout(resolve, 5));
          metadata -= 1;
        }),
      ),
      ...Array.from({ length: 4 }, () =>
        scheduler.run("package", async () => {
          packages += 1;
          packagePeak = Math.max(packagePeak, packages);
          await new Promise((resolve) => setTimeout(resolve, 5));
          packages -= 1;
        }),
      ),
    ]);
    expect(metadataPeak).toBeLessThanOrEqual(2);
    expect(packagePeak).toBe(1);
  });
});

describe("retry policy", () => {
  it("caps Retry-After and parses both forms", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    const date = new Date(Date.now() + 5_000).toUTCString();
    expect(parseRetryAfter(date) ?? 0).toBeGreaterThanOrEqual(4_000);
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });

  it("uses full jitter within an exponential cap", () => {
    const low = retryDelayMs(3, { random: () => 0 });
    const high = retryDelayMs(3, { random: () => 0.999 });
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(8_000);
    expect(high).toBeGreaterThanOrEqual(low);
    expect(retryDelayMs(1, { retryAfterMs: 60_000 })).toBe(30_000);
  });
});
