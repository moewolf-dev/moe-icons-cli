import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { checkVersionPublished } from "../scripts/release-preflight.mjs";

/**
 * E4: registry idempotency preflight. The query is read-only and the exact
 * version must be absent for the release to proceed. Unit cases use an
 * injected mock fetch; exit-code wiring is verified against a local mock
 * registry server so no real network is touched.
 */

const script = resolve("scripts/release-preflight.mjs");
const PACKAGE_VERSION = "0.0.1";

describe("release-preflight", () => {
  describe("checkVersionPublished (mock fetch)", () => {
    it("returns published:false when the exact version is absent", async () => {
      const result = await checkVersionPublished({
        version: PACKAGE_VERSION,
        fetchFn: async () =>
          new Response(
            JSON.stringify({ name: "@moewolf/moe-icons-cli", versions: { "0.0.9": {}, "0.1.1": {} } }),
            { status: 200 },
          ),
      });
      expect(result.published).toBe(false);
    });

    it("treats a 404 package document as absent (never published)", async () => {
      const result = await checkVersionPublished({
        version: PACKAGE_VERSION,
        fetchFn: async () => new Response("Not Found", { status: 404 }),
      });
      expect(result.published).toBe(false);
    });

    it("returns published:true when the exact version is already present", async () => {
      const result = await checkVersionPublished({
        version: PACKAGE_VERSION,
        fetchFn: async () =>
          new Response(
            JSON.stringify({ name: "@moewolf/moe-icons-cli", versions: { [PACKAGE_VERSION]: {} } }),
            { status: 200 },
          ),
      });
      expect(result.published).toBe(true);
    });

    it("fails with a NETWORK-ish message when the fetch rejects", async () => {
      await expect(
        checkVersionPublished({
          version: PACKAGE_VERSION,
          fetchFn: async () => {
            throw new TypeError("fetch failed");
          },
        }),
      ).rejects.toThrow(/network error/i);
    });

    it("fails when the registry returns an error status", async () => {
      await expect(
        checkVersionPublished({
          version: PACKAGE_VERSION,
          fetchFn: async () => new Response("Internal Server Error", { status: 500 }),
        }),
      ).rejects.toThrow(/HTTP 500/);
    });

    it("rejects a missing version argument", async () => {
      await expect(checkVersionPublished({ version: "" })).rejects.toThrow(/version/);
    });
  });

  describe("exit-code wiring (local mock registry)", () => {
    let server: Server;
    let port: number;

    function mockRegistry(body: string, status = 200): Promise<void> {
      server = createServer((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
      return new Promise<void>((done) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address !== null && typeof address === "object") port = address.port;
          done();
        });
      });
    }

    function closeServer(): Promise<void> {
      if (!server) return Promise.resolve();
      const closing = server;
      server = undefined as unknown as Server;
      return new Promise<void>((done) => closing.close(() => done()));
    }

    function spawnScript(
      args: string[],
    ): Promise<{ status: number; stdout: string; stderr: string }> {
      return new Promise((done, reject) => {
        const child = spawn("node", [script, ...args], {
          cwd: resolve("."),
          env: { ...process.env, MOEICONS_PREFLIGHT_REGISTRY_URL: `http://127.0.0.1:${port}` },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => done({ status: code ?? 1, stdout, stderr }));
      });
    }

    afterEach(async () => {
      await closeServer();
    });

    it("exits 0 when the version is absent", async () => {
      await mockRegistry(JSON.stringify({ versions: { "0.1.1": {} } }));
      const out = await spawnScript(["--json"]);
      expect(out.status).toBe(0);
      expect(JSON.parse(out.stdout) as { ok: boolean; published: boolean }).toMatchObject({
        ok: true,
        published: false,
      });
    });

    it("exits non-zero with an 'already published' message when present", async () => {
      await mockRegistry(JSON.stringify({ versions: { [PACKAGE_VERSION]: {} } }));
      const out = await spawnScript(["--json"]);
      expect(out.status).toBe(1);
      const parsed = JSON.parse(out.stdout) as { ok: boolean; message: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.message).toContain("already published");
    });

    it("exits non-zero with a NETWORK-ish message on a network error", async () => {
      await mockRegistry(JSON.stringify({ versions: {} }));
      await closeServer();
      const out = await spawnScript(["--json"]);
      expect(out.status).toBe(1);
      const parsed = JSON.parse(out.stdout) as { ok: boolean; message: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.message).toMatch(/network error/i);
    });

    it("emits the same already-published message in human mode on stderr", async () => {
      await mockRegistry(JSON.stringify({ versions: { [PACKAGE_VERSION]: {} } }));
      const out = await spawnScript([]);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("already published");
    });
  });
});
