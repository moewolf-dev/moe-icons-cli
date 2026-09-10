import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRemotePolicy } from "../scripts/verify-release-policy-remote.mjs";

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor", "moe-icons-release-policy");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("RELEASE-BITMAP-0909 release policy (B7)", () => {
  it("vendors the frozen four-group contract with a matching PIN", () => {
    const file = path.join(vendorDir, "free-style-groups.v1.json");
    const pin = JSON.parse(fs.readFileSync(path.join(vendorDir, "PIN.json"), "utf8"));
    const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    expect(pin.sha256).toBe(sha);
    expect(pin.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.sourcePath).toBe("contracts/release-policy/free-style-groups.v1.json");
    const policy = JSON.parse(fs.readFileSync(file, "utf8"));
    expect([...policy.freeStyleGroups].sort()).toEqual([
      "moe-colored",
      "moe-lite-outline",
      "moe-outline",
      "moe-solid",
    ]);
  });

  it("has no retired three-group Free literal in source or workflows", () => {
    const forbidden = ["moe-outline", "moe-solid", "moe-lite-outline"].join(",");
    const offenders = [".github", "src", "scripts"]
      .flatMap((rel) => walk(path.join(root, rel)))
      .filter((file) => fs.readFileSync(file, "utf8").includes(forbidden))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("AUD-BLOCK-02: remote pinned verification accepts exact bytes and rejects drift", async () => {
    const bytes = fs.readFileSync(path.join(vendorDir, "free-style-groups.v1.json"));

    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(bytes);
    }, async (base) => {
      await expect(verifyRemotePolicy({ root, rawBase: base })).resolves.toMatchObject({
        sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
    });

    await withServer((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    }, async (base) => {
      await expect(verifyRemotePolicy({ root, rawBase: base })).rejects.toThrow(/HTTP 404/);
    });

    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.from('{"schemaVersion":1,"freeStyleGroups":["moe-outline"]}\n'));
    }, async (base) => {
      await expect(verifyRemotePolicy({ root, rawBase: base })).rejects.toThrow(/SHA-256|differs/);
    });
  });

  it("SEC-A2-05A: npm publish has no long-lived token path", () => {
    const workflows = walk(path.join(root, ".github"));
    const offenders: string[] = [];
    for (const file of workflows) {
      const text = fs.readFileSync(file, "utf8");
      if (/secrets\.NPM_TOKEN|NODE_AUTH_TOKEN\s*[:=]|_authToken\s*[:=]|npm config set [^\n]*_authToken/.test(text)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
    const publish = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(publish).toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/--provenance/);
    expect(publish).toMatch(/environment:\s*npm-publish/);
  });
});
