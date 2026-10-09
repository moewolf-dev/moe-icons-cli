import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRemotePolicy } from "../scripts/verify-release-policy-remote.mjs";
import { waitForRegistryPackage } from "../scripts/wait-for-registry-package.mjs";
import { shouldAutoResume } from "../scripts/auto-resume-publish.mjs";

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

  it("SEC-A2-05A: token override is confined to protected manual publish", () => {
    const publish = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
    for (const file of walk(path.join(root, ".github"))) {
      const text = fs.readFileSync(file, "utf8");
      if (file !== path.join(root, ".github", "workflows", "publish.yml")) {
        expect(text).not.toMatch(/secrets\.NPM_TOKEN|NODE_AUTH_TOKEN\s*[:=]/);
      }
      expect(text).not.toMatch(/_authToken\s*[:=]|npm config set [^\n]*_authToken/);
    }
    const preflight = publish.slice(publish.indexOf("  npm-auth-preflight:"), publish.indexOf("  # R-P0-2:"));
    expect(preflight).toContain("if: github.event_name == 'workflow_dispatch' && inputs.npm_auth_mode == 'token'");
    expect(preflight).toContain("environment: npm-publish");
    expect(preflight).toContain("permissions:");
    expect(preflight).toContain("contents: read");
    expect(preflight).toContain("npm whoami >/dev/null");
    expect(preflight).not.toMatch(/\bnpm publish\b|\bgit push\b|\bgh api\b|checkout@/);
    expect(publish.match(/secrets\.NPM_TOKEN/g)).toHaveLength(2);
    const offset = publish.lastIndexOf("secrets.NPM_TOKEN");
    expect(offset).toBeGreaterThan(publish.indexOf("      - name: Publish to npm or verify"));
    expect(offset).toBeLessThan(publish.indexOf("      - name: Wait for public registry visibility"));
    expect(publish).toContain("github.event_name == 'workflow_dispatch' && inputs.npm_auth_mode == 'token'");
    expect(publish).toMatch(/default: oidc/);
    expect(publish).toMatch(/npm whoami >\/dev\/null/);
    expect(publish).toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/--provenance/);
    expect(publish).toMatch(/environment:\s*npm-publish/);
  });

  it("retries npm metadata and tarball visibility failures within a bounded window", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const commands: string[] = [];
    const result = await waitForRegistryPackage({
      packageName: "@moewolf/moe-icons-cli",
      version: "0.0.11",
      maxWaitMs: 60_000,
      retryDelaysMs: [1000, 2000],
      now: () => time,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        time += milliseconds;
      },
      runCommand: (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        if (commands.length === 1) return { status: 1, stderr: "npm error E404" };
        if (commands.length === 3) return { status: 1, stderr: "npm error 404 Not Found tarball" };
        return { status: 0, stdout: "0.0.11\n" };
      },
    });
    expect(result).toMatchObject({ version: "0.0.11", attempts: 3, smokeOutput: "0.0.11" });
    expect(sleeps).toEqual([1000, 2000]);
    expect(commands).toHaveLength(5);
    expect(commands[2]).toContain("npx --yes --prefer-online");
  });

  it("stops immediately for non-transient npm authorization failures", async () => {
    const runCommand = vi.fn(() => ({ status: 1, stderr: "npm error E401" }));
    await expect(waitForRegistryPackage({
      packageName: "@moewolf/moe-icons-cli",
      version: "0.0.11",
      runCommand,
      sleep: async () => { throw new Error("unexpected retry"); },
    })).rejects.toThrow(/failed permanently/);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("auto-resumes only one exact publish candidate after a recognized registry timeout", () => {
    const parentRun = { path: ".github/workflows/publish.yml", head_branch: "main", conclusion: "failure" };
    const jobs = [{
      name: "publish",
      conclusion: "failure",
      steps: [
        { name: "Publish to npm or verify the existing registry package", conclusion: "success" },
        { name: "Wait for public registry visibility and smoke npx install", conclusion: "failure" },
      ],
    }];
    const failedLogs = "npm package @moewolf/moe-icons-cli@0.0.11 did not become installable within 1800000ms";
    expect(shouldAutoResume({ parentRun, jobs, failedLogs, priorResumeCount: 0 })).toMatchObject({ resume: true });
    expect(shouldAutoResume({ parentRun, jobs, failedLogs, priorResumeCount: 1 })).toMatchObject({ resume: false });
    expect(shouldAutoResume({ parentRun: { ...parentRun, head_branch: "pull/9" }, jobs, failedLogs, priorResumeCount: 0 })).toMatchObject({ resume: false });
    expect(shouldAutoResume({ parentRun, jobs: [{ name: "pack", conclusion: "failure" }], failedLogs, priorResumeCount: 0 })).toMatchObject({ resume: false });
    expect(shouldAutoResume({ parentRun, jobs, failedLogs: "npx package smoke failed permanently", priorResumeCount: 0 })).toMatchObject({ resume: false });

    const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish-auto-resume.yml"), "utf8");
    expect(workflow).toContain("workflows: [Publish CLI]");
    expect(workflow).toContain("actions: write");
    expect(workflow).not.toMatch(/secrets\.NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("auto-resumes verified npm publication when Release or receipt finalization fails", () => {
    const parentRun = { path: ".github/workflows/publish.yml", head_branch: "main", conclusion: "failure" };
    const priorSuccess = [
      { name: "Publish to npm or verify the existing registry package", conclusion: "success" },
      { name: "Wait for public registry visibility and smoke npx install", conclusion: "success" },
    ];
    const finalizationSteps = [
      "Finalize the Release",
      "Write the canonical publish receipt",
      "Upload the publish receipt",
      "Preserve immutable public publish receipt for downstream replay",
    ];
    for (const name of finalizationSteps) {
      const jobs = [{ name: "publish", conclusion: "failure", steps: [...priorSuccess, { name, conclusion: "failure" }] }];
      expect(shouldAutoResume({ parentRun, jobs, priorResumeCount: 0 })).toMatchObject({ resume: true });
      expect(shouldAutoResume({ parentRun, jobs, priorResumeCount: 1 })).toMatchObject({ resume: false });
    }

    const notYetPublished = [{ name: "publish", conclusion: "failure", steps: [
      { name: "Publish to npm or verify the existing registry package", conclusion: "failure" },
      { name: "Finalize the Release", conclusion: "skipped" },
    ] }];
    expect(shouldAutoResume({ parentRun, jobs: notYetPublished, priorResumeCount: 0 })).toMatchObject({ resume: false });

    expect(shouldAutoResume({
      parentRun: { ...parentRun, display_title: "Publish CLI resume:123456" },
      jobs: [{ name: "publish", conclusion: "failure", steps: [...priorSuccess, { name: "Finalize the Release", conclusion: "failure" }] }],
      priorResumeCount: 0,
    })).toMatchObject({ resume: false, reason: "this publish run is already an automatic resume" });

    const visibilityUnverified = [{ name: "publish", conclusion: "failure", steps: [
      { name: "Publish to npm or verify the existing registry package", conclusion: "success" },
      { name: "Wait for public registry visibility and smoke npx install", conclusion: "failure" },
      { name: "Finalize the Release", conclusion: "skipped" },
    ] }];
    expect(shouldAutoResume({ parentRun, jobs: visibilityUnverified, priorResumeCount: 0 })).toMatchObject({ resume: false });
  });
});
