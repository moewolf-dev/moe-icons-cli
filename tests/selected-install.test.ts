import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstallUseCase } from "../src/core/install.js";
import { runGenerateUseCase } from "../src/core/generate.js";
import { runLibraryUpdateUseCase } from "../src/core/library-update.js";
import { writeFreeReleaseFixture, targetSubtreeFiles } from "./helpers/free-release-fixture.js";
import { selectedFixture } from "./helpers/selected-resource-fixture.js";
import { sha256Bytes } from "../src/project/install-metadata.js";
import { readMoeiconsConfig } from "../src/project/config.js";
import type { CommandContext } from "../src/core/context.js";
import type { Target } from "../src/commands/parser.js";

function setup(target: Target) {
  const root = fs.mkdtempSync(join(tmpdir(), "moe-selected-install-")),
    project = join(root, "project"),
    fixture = join(root, "release"),
    cache = join(root, "cache");
  fs.mkdirSync(project);
  fs.mkdirSync(fixture);
  fs.mkdirSync(cache);
  fs.writeFileSync(join(project, "package.json"), '{"name":"selected","version":"1.0.0"}');
  const config = {
    schemaVersion: 3,
    tier: "free",
    target,
    outputDir: "src/icons",
    defaultTheme: "outline",
    themes: { outline: { styleGroup: "moe-outline" } },
    icons: ["arrow-bold-right"],
    missingIconPolicy: "error",
    downloadMode: "icons",
  };
  fs.writeFileSync(join(project, "moeicons.config.json"), JSON.stringify(config));
  const base = writeFreeReleaseFixture(fixture, { version: "0.0.18", useBundledCatalog: true });
  const input: Record<string, string> = {};
  for (const [kind, files] of Object.entries(targetSubtreeFiles()))
    for (const [path, source] of Object.entries(files)) input[`${kind}/${path}`] = source;
  input["vanilla/moe-outline/ArrowBoldRight.js"] =
    "export default function createIcon() { return document.createElementNS('http://www.w3.org/2000/svg','svg'); }";
  input["vanilla/moe-outline/ArrowBoldRight.d.ts"] =
    "export default function createIcon(): SVGElement;";
  const resources = selectedFixture(input, {}, "free", base.version, base.freeSha);
  const descriptor = JSON.parse(fs.readFileSync(join(fixture, "release-descriptor.json"), "utf8"));
  descriptor.free.resources = resources.refs;
  const text = JSON.stringify(descriptor);
  const descriptorSha = sha256Bytes(text);
  fs.writeFileSync(join(fixture, "release-descriptor.json"), text);
  fs.writeFileSync(
    join(fixture, "release-descriptor.json.sha256"),
    `${descriptorSha}  release-descriptor.json\n`,
  );
  fs.writeFileSync(
    join(fixture, "release-latest.json"),
    JSON.stringify({
      schemaVersion: 1,
      tier: "free",
      fullVersion: base.version,
      descriptorSha256: descriptorSha,
      assets: {},
    }),
  );
  fs.writeFileSync(join(fixture, resources.refs.index.filename), resources.indexBytes);
  fs.writeFileSync(join(fixture, resources.refs.bundle.filename), resources.bundle);
  const notes: string[] = [];
  const context: CommandContext = {
    cwd: project,
    env: { MOEICONS_CACHE_DIR: cache },
    signal: new AbortController().signal,
    now: () => new Date(),
    ui: {
      select: async () => undefined,
      confirm: async () => true,
      text: async () => undefined,
      note: (text) => {
        notes.push(text);
      },
      progress: () => ({ stop() {} }),
    },
  };
  const io = {
    writeFileSync: fs.writeFileSync,
    existsSync: fs.existsSync,
    renameSync: fs.renameSync,
    rmSync: fs.rmSync,
    readdirSync: fs.readdirSync,
    mkdirSync: (path: string) => {
      fs.mkdirSync(path, { recursive: true });
    },
    readFileSync: (path: string) => new Uint8Array(fs.readFileSync(path)),
    fetchFn: async () => {
      throw new Error("unexpected network");
    },
    cacheDir: cache,
    fixtureDir: fixture,
    cliVersion: "0.0.1",
  };
  return {
    root,
    project,
    fixture,
    cache,
    config,
    base,
    resources,
    descriptorSha,
    context,
    notes,
    io,
  };
}
describe("config driven selected install, offline generation and same version reconcile", () => {
  for (const target of ["react", "vue", "vanilla", "assets"] as const)
    it(`installs and generates ${target} without full archive/cache, then reconciles the same fixed release`, async () => {
      const s = setup(target);
      try {
        // A valid whole archive exists but must never be read in icons mode.
        fs.rmSync(join(s.fixture, s.base.freeName));
        const result = await runInstallUseCase(
          s.context,
          { fs, download: s.io },
          { group: "free", sourceVersion: s.base.version },
        );
        expect(result).toMatchObject({ ok: true, downloadMode: "icons" });
        expect(s.notes.join("\n")).toContain("Download plan:");
        expect(fs.existsSync(join(s.cache, "artifacts"))).toBe(false);
        const config = readMoeiconsConfig(s.project);
        expect(config.kind).toBe("ok");
        if (config.kind !== "ok") throw new Error("config");
        const generated = await runGenerateUseCase(s.context, fs, { noTailwind: true });
        expect(generated).toMatchObject({ ok: true });
        const updated = await runLibraryUpdateUseCase(
          s.context,
          { fs, free: s.io, auth: {} },
          { tier: "free", version: s.base.version, descriptorSha256: s.descriptorSha },
        );
        expect(updated.downloadMode).toBe("icons");
        expect(updated.networkBytes).toBe(0);
        const before = fs.readFileSync(join(s.project, ".moeicons/install-metadata.json"), "utf8");
        fs.writeFileSync(
          join(s.project, "moeicons.config.json"),
          JSON.stringify({ ...s.config, icons: [] }),
        );
        await expect(
          runLibraryUpdateUseCase(
            s.context,
            { fs, free: s.io, auth: {} },
            { tier: "free", version: s.base.version, descriptorSha256: s.descriptorSha },
          ),
        ).rejects.toThrow("config.icons must contain at least one icon ID");
        expect(fs.readFileSync(join(s.project, ".moeicons/install-metadata.json"), "utf8")).toBe(
          before,
        );
        expect(
          await runInstallUseCase(s.context, { fs, download: s.io }, { group: "free" }),
        ).toMatchObject({ ok: false, reason: "validation" });
        expect(
          fs.readFileSync(join(s.project, ".moeicons/install-metadata.json"), "utf8"),
        ).toContain('"mode": "icons"');
      } finally {
        fs.rmSync(s.root, { recursive: true, force: true });
      }
    });
  it("refuses a config rewrite during resource planning without installing files", async () => {
    const s = setup("react");
    try {
      const context = {
        ...s.context,
        ui: {
          ...s.context.ui,
          note: () =>
            fs.writeFileSync(
              join(s.project, "moeicons.config.json"),
              JSON.stringify({ ...s.config, icons: ["ui-search"] }),
            ),
        },
      };
      const result = await runInstallUseCase(
        context,
        { fs, download: s.io },
        { group: "free", sourceVersion: s.base.version },
      );
      expect(result).toMatchObject({ ok: false, reason: "validation" });
      expect(fs.existsSync(join(s.project, ".moeicons/install-metadata.json"))).toBe(false);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});

import { runProInstallUseCase } from "../src/core/pro-install.js";
import type { TokenStore, StoredSession } from "../src/auth/token-store.js";
import { createServer } from "node:http";
it("Pro selected install renews an expired resource URL, never downloads full code and generates offline", async () => {
  const s = setup("react");
  const identity = "d".repeat(64);
  let fullRequests = 0,
    indexRequests = 0,
    bundleDescriptors = 0,
    ranges = 0;
  const base = writeFreeReleaseFixture(s.fixture, {
    version: "0.0.18",
    useBundledCatalog: true,
    tier: "pro",
  });
  const resources = selectedFixture(
    {
      "react/types.d.ts": "export interface ReactIconProps {}",
      "react/moe-outline/ArrowBoldRight.js": "export default function Icon() {}",
      "react/moe-outline/ArrowBoldRight.d.ts": "export default function Icon(): unknown;",
    },
    {},
    "pro",
    base.version,
    base.freeSha,
  );
  const metadata = fs.readFileSync(join(s.fixture, base.metadataName));
  const server = createServer((request, response) => {
    if (request.url === "/code") {
      fullRequests++;
      response.writeHead(500);
      response.end();
      return;
    }
    if (request.headers.authorization) {
      response.writeHead(400);
      response.end("Bearer leaked to resource server");
      return;
    }
    if (request.url === "/metadata") {
      response.end(metadata);
      return;
    }
    if (request.url === "/index") {
      indexRequests++;
      response.end(resources.indexBytes);
      return;
    }
    if (request.url === "/expired") {
      response.writeHead(403);
      response.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (!match) {
      response.writeHead(400);
      response.end();
      return;
    }
    const start = Number(match[1]),
      end = Number(match[2]);
    ranges++;
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${resources.bundle.length}`,
    });
    response.end(resources.bundle.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fs.writeFileSync(
    join(s.project, "moeicons.config.json"),
    JSON.stringify({ ...s.config, tier: "pro" }),
  );
  const context = {
    ...s.context,
    env: {
      ...s.context.env,
      MOEICONS_PRO_DESCRIPTOR_URL: `${origin}/v1/icon-library/pro/artifact-descriptor`,
    },
  };
  const stored: StoredSession = {
    accountId: "auth0|selected",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
    scope: "openid",
    storedAt: Date.now(),
  };
  const store: TokenStore = {
    get: () => stored,
    getActive: () => stored,
    set() {},
    delete() {},
    clear() {},
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const expiresAt = new Date(Date.now() + 120000).toISOString();
    if (url.endsWith("/artifact-descriptor")) {
      expect(new Headers(init?.headers).get("X-Moeicons-Resources")).toBe("v1");
      return Response.json({
        ok: true,
        tier: "pro",
        version: base.version,
        descriptorSha256: identity,
        catalogFilename: "catalog.json",
        catalogSha256: base.catalogSha,
        url: `${origin}/code`,
        expiresAt,
        size: 100,
        sha256: base.freeSha,
        resources: resources.refs,
        metadata: {
          url: `${origin}/metadata`,
          expiresAt,
          size: metadata.length,
          sha256: sha256Bytes(metadata),
        },
      });
    }
    if (url.endsWith("/resource-descriptor")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
      const body = JSON.parse(String(init?.body));
      const kind = body.kind;
      const ref = kind === "resource-index" ? resources.refs.index : resources.refs.bundle;
      if (kind === "resource-bundle") bundleDescriptors++;
      return Response.json({
        ok: true,
        tier: "pro",
        version: base.version,
        descriptorSha256: identity,
        kind,
        ...ref,
        parentArtifactSha256: base.freeSha,
        url: `${origin}/${kind === "resource-index" ? "index" : bundleDescriptors === 1 ? "expired" : "bundle"}`,
        expiresAt,
      });
    }
    return fetch(input, init);
  };
  try {
    const result = await runProInstallUseCase(
      context,
      { fs, auth: { tokenStore: store }, fetch: fetchFn },
      { version: base.version, descriptorSha256: identity },
    );
    expect(result.downloadMode).toBe("icons");
    expect(fullRequests).toBe(0);
    expect(indexRequests).toBe(1);
    expect(ranges).toBe(3);
    expect(bundleDescriptors).toBeGreaterThan(1);
    const generated = await runGenerateUseCase(context, fs, { noTailwind: true });
    expect(generated).toMatchObject({ ok: true });
    // A cache hit still checks current entitlement/catalog through the API,
    // but does not sign/request the data object or read unverified cache bytes.
    const previous = bundleDescriptors;
    const second = await runProInstallUseCase(
      context,
      { fs, auth: { tokenStore: store }, fetch: fetchFn },
      { version: base.version, descriptorSha256: identity },
    );
    expect(second.networkBytes).toBe(0);
    expect(bundleDescriptors).toBe(previous);
    expect(fullRequests).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
