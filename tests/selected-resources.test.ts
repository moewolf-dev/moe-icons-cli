import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { catalog } from "../src/catalog/catalog.js";
import type { MoeiconsConfigFile } from "../src/project/config.js";
import {
  parseResourceIndex,
  planSelectedResources,
  downloadSelectedResources,
  type ResourceFile,
} from "../src/core/selected-resources.js";
import { sha256Bytes } from "../src/project/install-metadata.js";
import { selectedFixture } from "./helpers/selected-resource-fixture.js";
const config: MoeiconsConfigFile = {
  schemaVersion: 3,
  tier: "free",
  target: "react",
  outputDir: "src/moeicons",
  defaultTheme: "outline",
  themes: {
    outline: { styleGroup: "moe-outline", icons: ["ui-search"] },
    solid: { styleGroup: "moe-solid", icons: ["arrow-bold-right"] },
  },
  icons: ["ui-search", "arrow-bold-right"],
  missingIconPolicy: "fallback",
  downloadMode: "icons",
};
const fixture = () =>
  selectedFixture(
    {
      "react/types.d.ts": "type P={};",
      "react/moe-outline/UiSearch.js": "search",
      "react/moe-outline/UiSearch.d.ts": "search types",
      "react/moe-solid/ArrowBoldRight.js": "arrow",
      "react/moe-solid/ArrowBoldRight.d.ts": "arrow types",
      "react/moe-solid/UiSearch.js": "unselected",
      "react/moe-solid/UiSearch.d.ts": "unselected types",
    },
    {
      "react/moe-outline/UiSearch.d.ts": ["react/types.d.ts"],
      "react/moe-solid/ArrowBoldRight.d.ts": ["react/types.d.ts"],
    },
  );

function planWithBudgetedDependencies(
  data: ReturnType<typeof fixture>,
  budget: "expandedBytes" | "payloadBytes",
  excessBytes = 0,
) {
  const files: Record<string, ResourceFile> = structuredClone(data.index.files);
  const index = { ...data.index, files };
  const baseline = planSelectedResources(config, catalog, index);
  const existingBytes = baseline.paths.reduce(
    (sum, path) => sum + index.files[path]![budget === "expandedBytes" ? "size" : "compressedSize"],
    0,
  );
  const limit = 768 * 1024 * 1024;
  const dependencyCount = 24;
  const dependencyPaths = Array.from(
    { length: dependencyCount },
    (_, i) => `react/generated/dependency-${i}.d.ts`,
  );
  const perDependency = 32 * 1024 * 1024;
  const lastBytes = limit + excessBytes - existingBytes - perDependency * (dependencyCount - 1);
  if (lastBytes < 1 || lastBytes > perDependency) throw new Error("invalid selected-resource budget fixture");
  index.files["react/types.d.ts"] = {
    ...index.files["react/types.d.ts"]!,
    requires: dependencyPaths,
  };
  dependencyPaths.forEach((path, i) => {
    const amount = i === dependencyCount - 1 ? lastBytes : perDependency;
    index.files[path] = {
      offset: 0,
      compressedSize: budget === "payloadBytes" ? amount : 1,
      compressedSha256: "a".repeat(64),
      size: budget === "expandedBytes" ? amount : 1,
      sha256: "b".repeat(64),
      requires: [],
    };
  });
  return planSelectedResources(config, catalog, index);
}
describe("selected resource immutable contract and configuration plan", () => {
  it.each(["expandedBytes", "payloadBytes"] as const)(
    "admits exactly 768 MiB of selected %s using bounded metadata only",
    (budget) => {
      expect(() => planWithBudgetedDependencies(fixture(), budget)).not.toThrow();
    },
  );
  it.each(["expandedBytes", "payloadBytes"] as const)(
    "rejects selected %s one byte above 768 MiB",
    (budget) => {
      expect(() => planWithBudgetedDependencies(fixture(), budget, 1)).toThrow(/768 MiB budget/);
    },
  );
  it("deduplicates fallback variants and does not select unused theme icons", () => {
    const data = fixture();
    const parsed = parseResourceIndex(data.indexBytes, data.refs, {
      version: "0.0.18",
      tier: "free",
      artifactSha256: "a".repeat(64),
    });
    const plan = planSelectedResources(config, catalog, parsed);
    expect(plan.paths).toHaveLength(5);
    expect(plan.paths.some((path) => path.includes("solid/UiSearch"))).toBe(false);
    expect(plan.fallbacks).toEqual([
      "arrow-bold-right: outline -> solid",
      "ui-search: solid -> outline",
    ]);
  });
  it("rejects a changed release, corrupt index, unsafe paths, overlap, missing dependency and oversized resource", () => {
    const original = fixture();
    expect(() =>
      parseResourceIndex(original.indexBytes, original.refs, {
        version: "0.0.19",
        tier: "free",
        artifactSha256: "a".repeat(64),
      }),
    ).toThrow("identity mismatch");
    expect(() =>
      parseResourceIndex(Buffer.from("bad"), original.refs, {
        version: "0.0.18",
        tier: "free",
        artifactSha256: "a".repeat(64),
      }),
    ).toThrow("SHA-256");
    for (const mutation of [
      (index: any) => {
        index.files["react/../escape"] = index.files["react/types.d.ts"];
      },
      (index: any) => {
        index.files["react/types.d.ts"].offset = 0;
      },
      (index: any) => {
        index.files["react/types.d.ts"].requires = ["react/missing.js"];
      },
      (index: any) => {
        index.files["react/types.d.ts"].size = 33 * 1024 * 1024;
      },
    ]) {
      const index = structuredClone(original.index);
      mutation(index);
      const bytes = gzipSync(Buffer.from(JSON.stringify(index)));
      expect(() =>
        parseResourceIndex(
          bytes,
          {
            ...original.refs,
            index: { ...original.refs.index, size: bytes.length, sha256: sha256Bytes(bytes) },
          },
          { version: "0.0.18", tier: "free", artifactSha256: "a".repeat(64) },
        ),
      ).toThrow();
    }
  });
  it("fails the plan for unregistered/missing variants before resource fetch", () => {
    const data = fixture();
    expect(() =>
      planSelectedResources({ ...config, icons: ["archive"] }, catalog, data.index),
    ).toThrow("no selected variant");
    expect(() =>
      planSelectedResources({ ...config, missingIconPolicy: "error" }, catalog, data.index),
    ).toThrow("no selected variant");
  });
});
describe("real HTTP range, cache and failure behavior", () => {
  it("requests only selected ranges, sends no Bearer, supports cold cache then verified offline reuse", async () => {
    const data = fixture();
    const calls: Array<{ start: number; size: number; auth?: string }> = [];
    const server = createServer((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (!match) {
        response.writeHead(400);
        response.end();
        return;
      }
      const start = Number(match[1]),
        end = Number(match[2]);
      calls.push({
        start,
        size: end - start + 1,
        ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
      });
      response.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${data.bundle.length}`,
        "Content-Length": end - start + 1,
      });
      response.end(data.bundle.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const root = fs.mkdtempSync(join(tmpdir(), "moe-range-cache-"));
    const io = {
      ...fs,
      mkdirSync: (path: string) => {
        fs.mkdirSync(path, { recursive: true });
      },
    };
    const options = {
      io,
      cacheDir: root,
      fetch,
      signal: new AbortController().signal,
      allowedHosts: [`127.0.0.1:${port}`],
      allowLoopback: true,
      getBundleUrl: async () => `http://127.0.0.1:${port}/bundle`,
    };
    try {
      const plan = planSelectedResources(config, catalog, data.index);
      const first = await downloadSelectedResources(
        data.index,
        data.refs.index.sha256,
        plan.paths,
        options,
      );
      expect(Object.keys(first.files)).toEqual(expect.arrayContaining([...plan.paths]));
      expect(first.networkBytes).toBe(plan.payloadBytes);
      expect(first.cacheHits).toBe(0);
      expect(calls).toHaveLength(5);
      expect(calls.some((call) => call.auth)).toBe(false);
      for (const call of calls)
        expect(
          plan.paths.some(
            (path) =>
              data.index.files[path]!.offset === call.start &&
              data.index.files[path]!.compressedSize === call.size,
          ),
        ).toBe(true);
      const cached = await downloadSelectedResources(
        data.index,
        data.refs.index.sha256,
        plan.paths,
        {
          ...options,
          offline: true,
          fetch: async () => {
            throw new Error("network must not be called");
          },
          getBundleUrl: async () => {
            throw new Error("auth must not be called");
          },
        },
      );
      expect(cached.networkBytes).toBe(0);
      expect(cached.cacheHits).toBe(5);
      expect(calls).toHaveLength(5);
      const broken = join(
        root,
        "resources/free/0.0.18",
        data.refs.index.sha256,
        data.index.files[plan.paths[0]!]!.compressedSha256,
      );
      fs.writeFileSync(broken, "corrupt");
      await expect(
        downloadSelectedResources(data.index, data.refs.index.sha256, plan.paths, {
          ...options,
          offline: true,
        }),
      ).rejects.toThrow("offline resource is missing or corrupt");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  for (const failure of ["ignored-range", "wrong-range", "truncated", "corrupt"])
    it(`refuses ${failure} without caching unverified bytes`, async () => {
      const data = fixture();
      const root = fs.mkdtempSync(join(tmpdir(), "moe-range-fault-"));
      const path = "react/types.d.ts",
        entry = data.index.files[path]!;
      const compressed = data.bundle.subarray(entry.offset, entry.offset + entry.compressedSize);
      try {
        await expect(
          downloadSelectedResources(data.index, data.refs.index.sha256, [path], {
            io: {
              ...fs,
              mkdirSync: (path: string) => {
                fs.mkdirSync(path, { recursive: true });
              },
            },
            cacheDir: root,
            signal: new AbortController().signal,
            allowedHosts: ["example.com"],
            getBundleUrl: async () => "https://example.com/bundle",
            fetch: async () =>
              new Response(
                failure === "corrupt"
                  ? Buffer.alloc(compressed.length)
                  : failure === "truncated"
                    ? compressed.subarray(0, -1)
                    : compressed,
                {
                  status: failure === "ignored-range" ? 200 : 206,
                  headers: {
                    "Content-Range":
                      failure === "wrong-range"
                        ? "bytes 0-1/2"
                        : `bytes ${entry.offset}-${entry.offset + entry.compressedSize - 1}/${data.bundle.length}`,
                  },
                },
              ),
          }),
        ).rejects.toThrow();
        expect(fs.readdirSync(root)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  it("rejects an untrusted redirect before a request carrying resource bytes", async () => {
    const data = fixture();
    let calls = 0;
    const root = fs.mkdtempSync(join(tmpdir(), "moe-range-redirect-"));
    try {
      await expect(
        downloadSelectedResources(data.index, data.refs.index.sha256, ["react/types.d.ts"], {
          io: {
            ...fs,
            mkdirSync: (path: string) => {
              fs.mkdirSync(path, { recursive: true });
            },
          },
          cacheDir: root,
          signal: new AbortController().signal,
          allowedHosts: ["example.com"],
          getBundleUrl: async () => "https://example.com/bundle",
          fetch: async () => {
            calls++;
            return new Response(null, {
              status: 302,
              headers: { location: "https://evil.example.com/bundle" },
            });
          },
        }),
      ).rejects.toThrow("untrusted host");
      expect(calls).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
