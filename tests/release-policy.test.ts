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
    // Scoped packages do not run by package name; the published bin is `moeicons`.
    expect(commands[2]).toContain("--package @moewolf/moe-icons-cli@0.0.11 moeicons --version");
  });

  it("retries a not-yet-replicated released version reported as ETARGET", async () => {
    let time = 0;
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await waitForRegistryPackage({
      packageName: "@moewolf/moe-icons-cli",
      version: "0.0.19",
      maxWaitMs: 300_000,
      retryDelaysMs: [10_000, 20_000, 40_000],
      now: () => time,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        time += milliseconds;
      },
      runCommand: () => {
        attempts += 1;
        if (attempts <= 3) return { status: 1, stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @moewolf/moe-icons-cli@0.0.19." };
        return { status: 0, stdout: "0.0.19\n" };
      },
    });
    expect(result).toMatchObject({ version: "0.0.19", attempts: 4, smokeOutput: "0.0.19" });
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("resumes the recorded intent version instead of publishing a new one", () => {
    const publish = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
    // The intent artifact is discoverable by the original pin identity.
    expect(publish).toMatch(/name: cli-publish-intent-\$\{\{ needs\.recover\.outputs\.pin_commit \|\| github\.sha \}\}/);
    // decide must look the intent up before the "payload unchanged" check and
    // continue that exact version when npm already has it.
    const resumeAt = publish.indexOf("resuming the recorded intent version");
    const payloadAt = publish.indexOf('LAST="$(gh release view');
    expect(resumeAt).toBeGreaterThanOrEqual(0);
    expect(payloadAt).toBeGreaterThan(resumeAt);
    const resume = publish.slice(resumeAt - 2500, resumeAt + 1200);
    expect(resume).toMatch(/actions\/artifacts\?name=cli-publish-intent-\$\{GITHUB_SHA\}/);
    expect(resume).toMatch(/next_version=\$RESUME_VERSION/);
  });

  it("writes the canonical receipt only after the staged evidence agrees", () => {
    const publish = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
    const verifyAt = publish.indexOf("Verify the staged recovery evidence matches this receipt");
    const receiptAt = publish.indexOf("Write the canonical publish receipt");
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(receiptAt).toBeGreaterThan(verifyAt);
    const verify = publish.slice(verifyAt, receiptAt);
    expect(verify).toContain("verify-publish-evidence.mjs");
    expect(verify).toContain("--require-accepted");
    expect(verify).toContain("needs.recover.outputs.pin_commit || github.sha");
    // The command-result stage is uploaded before any registry read can fail.
    const commandAt = publish.indexOf("Upload the publish command result before any registry read");
    const readAt = publish.indexOf("Read the published integrity with a bounded retry");
    expect(commandAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(commandAt);
  });

  it("only a proven push no-op may skip a missing publish receipt", () => {
    const notify = fs.readFileSync(path.join(root, ".github", "workflows", "plugin-update.yml"), "utf8");
    // The absence of a receipt may only mean "nothing to publish" for a
    // successful ordinary push; a manual/recovery request must carry evidence.
    expect(notify).toMatch(/TRIGGER_EVENT: \$\{\{ github\.event\.workflow_run\.event \|\| 'workflow_dispatch' \}\}/);
    expect(notify).toMatch(/TRIGGER_CONCLUSION: \$\{\{ github\.event\.workflow_run\.conclusion \|\| 'unknown' \}\}/);
    expect(notify).toMatch(/if \[ "\$TRIGGER_EVENT" = "push" \] && \[ "\$TRIGGER_CONCLUSION" = "success" \]/);
    expect(notify).toMatch(/Required publish receipt is missing/);
  });

  it("binds a reused receipt to the current candidate instead of the latest release", () => {
    const publish = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
    // The reused branch must prove the latest release is THIS candidate before it
    // may emit a successful receipt; otherwise another publish that advanced
    // first would be mis-bound to the pin.
    expect(publish).toMatch(/latest release \$TAG belongs to another candidate/);
    expect(publish).toMatch(/released resource identity at \$RELEASE_COMMIT differs from this candidate/);
    expect(publish).toMatch(/release tarball integrity differs from the npm package/);
    expect(publish).toMatch(/RELEASE_PAYLOAD/);
  });

  it("records the intent, the publish command result and the retried read before the receipt", () => {
    const publish = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
    const intentAt = publish.indexOf("Record the exact publish intent");
    const commandAt = publish.indexOf("Publish to npm or verify the existing registry package");
    const succeededAt = publish.indexOf("Record the publish command result");
    const readAt = publish.indexOf("Read the published integrity with a bounded retry");
    const smokeAt = publish.indexOf("Wait for public registry visibility and smoke npx install");
    const receiptAt = publish.indexOf("Write the canonical publish receipt");
    expect(intentAt).toBeGreaterThanOrEqual(0);
    expect(commandAt).toBeGreaterThan(intentAt);
    expect(succeededAt).toBeGreaterThan(commandAt);
    expect(readAt).toBeGreaterThan(succeededAt);
    expect(smokeAt).toBeGreaterThan(readAt);
    expect(receiptAt).toBeGreaterThan(smokeAt);
    // The command result must be durable without any registry read.
    const succeeded = publish.slice(succeededAt, readAt);
    expect(succeeded).not.toContain("npm view");
    // The read-back itself must be retried rather than failing on the first
    // propagation state (ETARGET/E404).
    expect(publish).toMatch(/for attempt in \$\(seq 1 40\)/);
    expect(publish).toMatch(/cli-publish-intent-/);
    expect(publish).toMatch(/cli-registry-accepted-/);
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

  it("runs the published smoke outside the package project so npm exec fetches the tarball", async () => {
    const calls: Array<{ command: string; cwd?: string | undefined }> = [];
    const result = await waitForRegistryPackage({
      packageName: "@moewolf/moe-icons-cli",
      version: "0.0.15",
      runCommand: (command, args, options) => {
        calls.push({ command: `${command} ${args.join(" ")}`, cwd: options?.cwd });
        return { status: 0, stdout: "0.0.15\n" };
      },
    });
    expect(result.smokeOutput).toBe("0.0.15");
    const smoke = calls.find((call) => call.command.startsWith("npx "));
    expect(smoke?.cwd).toBeTruthy();
    expect(smoke?.cwd).not.toBe(process.cwd());
    // Publish CLI runs this script from the package root, where package.json
    // already carries the same name/version. npm exec then treats the request
    // as a local install, never downloads the tarball, and fails with 127.
    expect(fs.existsSync(path.join(String(smoke?.cwd), "package.json"))).toBe(false);
    // The temporary smoke directory is removed once the wait completes.
    expect(fs.existsSync(String(smoke?.cwd))).toBe(false);
  });

  it("reports the published smoke stderr when the package cannot run", async () => {
    await expect(waitForRegistryPackage({
      packageName: "@moewolf/moe-icons-cli",
      version: "0.0.15",
      runCommand: (command) => command === "npx"
        ? { status: 127, stderr: "sh: 1: moeicons: not found" }
        : { status: 0, stdout: "0.0.15\n" },
      sleep: async () => { throw new Error("unexpected retry"); },
    })).rejects.toThrow(/moeicons: not found/);
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
