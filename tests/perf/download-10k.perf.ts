import { createServer } from "node:http";
import { readdirSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadArtifactToFile, cleanupDownloadTempDirsSync } from "../../src/project/download.js";
import {
  createDownloadScheduler,
  MAX_PACKAGE_CONCURRENCY,
} from "../../src/project/download-scheduler.js";

/**
 * REF-04/05 performance gate: 10,000 real HTTP packages through the shared
 * scheduler with a fixed worker count (no 10,000 running Promises).
 *
 * It records active-request peak, RSS peak, open file descriptors, temporary
 * directories and disk headroom. Absolute budgets are intentionally not
 * hard-coded: the test prints the baseline and only asserts the frozen
 * concurrency and bounded-resource invariants.
 */

const PACKAGES = Number(process.env.MOEICONS_PERF_PACKAGES ?? 10_000);
const WORKERS = 8;
const BODY = Buffer.alloc(256, 7);

let server: ReturnType<typeof createServer>;
let origin = "";
let active = 0;
let peak = 0;
const flakyAttempts = new Map<string, number>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    active += 1;
    peak = Math.max(peak, active);
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      active = Math.max(0, active - 1);
    };
    response.on("finish", release);
    response.on("close", release);
    if (path.startsWith("/flaky-")) {
      const attempts = (flakyAttempts.get(path) ?? 0) + 1;
      flakyAttempts.set(path, attempts);
      if (attempts === 1) {
        response.writeHead(503, { "content-length": "0", connection: "keep-alive" });
        response.end();
        return;
      }
    }
    if (path.startsWith("/slow-")) {
      const chunks = 4;
      response.writeHead(200, {
        "content-length": String(BODY.byteLength * chunks),
        connection: "keep-alive",
      });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        response.write(BODY);
        if (sent === chunks) {
          clearInterval(timer);
          response.end();
        }
      }, 10);
      return;
    }
    response.writeHead(200, {
      "content-length": String(BODY.byteLength),
      connection: "keep-alive",
    });
    response.end(BODY);
  });
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  cleanupDownloadTempDirsSync();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fdCount(): number {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return -1;
  }
}

function tempDirs(): string[] {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith("moeicons-download-"));
  } catch {
    return [];
  }
}

function freeBytes(): number {
  try {
    const stats = statfsSync(tmpdir());
    return stats.bavail * stats.bsize;
  } catch {
    return -1;
  }
}

describe("10,000 package download gate", () => {
  it("keeps active package requests <= 3 and resources bounded", async () => {
    const scheduler = createDownloadScheduler({ packageConcurrency: MAX_PACKAGE_CONCURRENCY });
    const before = {
      rss: process.memoryUsage().rss,
      fds: fdCount(),
      tempDirs: tempDirs().length,
      freeBytes: freeBytes(),
    };
    let rssPeak = before.rss;
    let fdPeak = before.fds;
    let tempDirPeak = before.tempDirs;
    const sample = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      fdPeak = Math.max(fdPeak, fdCount());
      tempDirPeak = Math.max(tempDirPeak, tempDirs().length);
    }, 50);
    const started = Date.now();
    let cursor = 0;
    let completed = 0;
    const failures: string[] = [];

    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        for (;;) {
          const index = cursor++;
          if (index >= PACKAGES) return;
          const result = await downloadArtifactToFile(`${origin}/package-${index}.tgz`, {
            maxBytes: BODY.byteLength,
            timeoutMs: 10_000,
            maxRedirects: 0,
            allowedHosts: [new URL(origin).host],
            allowHttpLoopback: true,
            scheduler,
            maxAttempts: 1,
          });
          if (!result.ok) {
            failures.push(result.code);
            continue;
          }
          if (result.file.size !== BODY.byteLength) failures.push("size-mismatch");
          await result.file.cleanup();
          completed += 1;
        }
      }),
    );
    clearInterval(sample);
    const elapsedMs = Date.now() - started;
    const stats = scheduler.stats();
    const report = {
      packages: PACKAGES,
      workers: WORKERS,
      completed,
      failures: failures.length,
      elapsedMs,
      requestsPerSecond: Math.round((completed / elapsedMs) * 1000),
      activePeak: stats.packagePeak,
      serverActivePeak: peak,
      rssBeforeBytes: before.rss,
      rssPeakBytes: rssPeak,
      rssGrowthBytes: rssPeak - before.rss,
      fdsBefore: before.fds,
      fdPeak,
      tempDirsBefore: before.tempDirs,
      tempDirPeak,
      tempDirsAfter: tempDirs().length,
      freeBytesBefore: before.freeBytes,
      freeBytesAfter: freeBytes(),
      schedulerQueuedAtEnd: stats.packageQueued,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
    };
    console.log(`PERF_REPORT ${JSON.stringify(report)}`);

    expect(failures).toHaveLength(0);
    expect(completed).toBe(PACKAGES);
    expect(stats.packagePeak).toBeLessThanOrEqual(MAX_PACKAGE_CONCURRENCY);
    expect(peak).toBeLessThanOrEqual(MAX_PACKAGE_CONCURRENCY);
    expect(stats.packageActive).toBe(0);
    expect(stats.packageQueued).toBe(0);
    expect(report.tempDirsAfter).toBe(report.tempDirsBefore);
  }, 600_000);
});

describe("error storm and slow-stream gate", () => {
  it("retries a transient 503 storm without exceeding the shared ceiling", async () => {
    const scheduler = createDownloadScheduler({ packageConcurrency: MAX_PACKAGE_CONCURRENCY });
    const beforePeak = scheduler.stats().packagePeak;
    let cursor = 0;
    let completed = 0;
    const failures: string[] = [];
    const tasks = 300;
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        for (;;) {
          const index = cursor++;
          if (index >= tasks) return;
          const result = await downloadArtifactToFile(`${origin}/flaky-${index}`, {
            maxBytes: BODY.byteLength,
            timeoutMs: 10_000,
            maxRedirects: 0,
            allowedHosts: [new URL(origin).host],
            allowHttpLoopback: true,
            scheduler,
            maxAttempts: 2,
            sleep: async () => undefined,
          });
          if (!result.ok) {
            failures.push(result.code);
            continue;
          }
          await result.file.cleanup();
          completed += 1;
        }
      }),
    );
    const stats = scheduler.stats();
    console.log(
      `PERF_STORM ${JSON.stringify({ tasks, completed, failures: failures.length, activePeak: stats.packagePeak, beforePeak })}`,
    );
    expect(failures).toHaveLength(0);
    expect(completed).toBe(tasks);
    expect(stats.packagePeak).toBeLessThanOrEqual(3);
    expect(stats.packageActive).toBe(0);
  }, 120_000);

  it("keeps slow streams bounded and drains the queue", async () => {
    const scheduler = createDownloadScheduler({ packageConcurrency: MAX_PACKAGE_CONCURRENCY });
    let cursor = 0;
    let completed = 0;
    const tasks = 60;
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        for (;;) {
          const index = cursor++;
          if (index >= tasks) return;
          const result = await downloadArtifactToFile(`${origin}/slow-${index}`, {
            maxBytes: BODY.byteLength * 4,
            timeoutMs: 10_000,
            maxRedirects: 0,
            allowedHosts: [new URL(origin).host],
            allowHttpLoopback: true,
            scheduler,
            maxAttempts: 1,
          });
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.file.size).toBe(BODY.byteLength * 4);
            await result.file.cleanup();
          }
          completed += 1;
        }
      }),
    );
    const stats = scheduler.stats();
    console.log(`PERF_SLOW ${JSON.stringify({ tasks, completed, activePeak: stats.packagePeak })}`);
    expect(completed).toBe(tasks);
    expect(stats.packagePeak).toBeLessThanOrEqual(3);
    expect(stats.packageQueued).toBe(0);
  }, 120_000);
});
