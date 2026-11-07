import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behavioural test of the REAL decide step.
 *
 * The step's shell body is extracted from publish.yml and executed with stubbed
 * gh/npm/sleep, so the assertions cover the workflow's observable outputs
 * (should_release / next_version / resume) rather than the presence of a string
 * in the file. This is the gate that caught the stale branch appended after the
 * new decision: it emitted 0.0.19 and then overwrote it with 0.0.21.
 */

const root = process.cwd();
const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");

function decideBody() {
  const marker = "        id: decide\n";
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error("decide step not found");
  const stepEnd = workflow.indexOf("\n  recover:\n", start);
  const block = workflow.slice(start, stepEnd);
  const runAt = block.indexOf("        run: |\n");
  if (runAt < 0) throw new Error("decide run block not found");
  return block
    .slice(runAt + "        run: |\n".length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

const payloadHash = (() => {
  const out = execFileSync(process.execPath, ["scripts/release-bump.mjs"], { cwd: root, encoding: "utf8" });
  return JSON.parse(out).payloadHash;
})();

function harness(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "moe-decide-it-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const runnerTemp = join(dir, "runner");
  mkdirSync(runnerTemp, { recursive: true });
  const output = join(dir, "output");
  writeFileSync(output, "");

  const intent = JSON.stringify({
    schemaVersion: 1,
    version: "0.0.19",
    tag: "v0.0.19",
    candidateSha256: "a".repeat(64),
    releaseCommit: "c".repeat(40),
    pinCommit: headSha,
    stage: "publish-intent",
  });

  const stubs = {
    sleep: "#!/bin/sh\nexit 0\n",
    npm: `#!/bin/sh
case "$MODE" in
  etarget) echo "npm error code ETARGET" >&2; exit 1 ;;
  *) echo "0.0.19"; exit 0 ;;
esac
`,
    gh: `#!/bin/sh
set -e
case "$1 $2" in
  "api repos/"*)
    case "$MODE" in
      lookup-fail) exit 1 ;;
      intent|etarget|download-fail) printf '%s\\n' '{"artifacts":[{"workflow_run":{"id":555}}]}'; exit 0 ;;
      *) printf '%s\\n' '{"artifacts":[]}'; exit 0 ;;
    esac ;;
  "run download")
    if [ "$MODE" = "download-fail" ]; then exit 1; fi
    mkdir -p "$RUNNER_TEMP/intent"
    printf '%s\\n' "$INTENT_JSON" > "$RUNNER_TEMP/intent/cli-publish-intent.json"
    exit 0 ;;
  "release list")
    echo "v0.0.20"; exit 0 ;;
  "release view")
    printf 'payloadHash: %s\\n' "$LAST_HASH"; exit 0 ;;
esac
exit 0
`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    const file = join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }

  const script = join(dir, "decide.sh");
  writeFileSync(script, `set -euo pipefail\n${decideBody()}\n`);

  const run = () =>
    new Promise<number | null>((resolve) => {
      const child = require("node:child_process").spawn("bash", [script], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MODE: mode,
          INTENT_JSON: intent,
          LAST_HASH: mode === "unchanged" ? payloadHash : "f".repeat(64),
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: runnerTemp,
          GITHUB_SHA: headSha,
          GITHUB_REPOSITORY: "moewolf-dev/moe-icons-cli",
          GITHUB_ACTOR: "someone",
        },
      });
      child.on("exit", (code: number | null) => resolve(code));
    });

  return {
    run,
    outputs: () => Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => line.split("="))),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("decide step behaviour", () => {
  it("pins 0.0.19 when an intent exists and npm is not readable yet (ETARGET)", async () => {
    const h = harness("etarget");
    try {
      expect(await h.run()).toBe(0);
      const out = h.outputs();
      expect(out.next_version).toBe("0.0.19");
      expect(out.should_release).toBe("1");
      expect(out.resume).toBe("1");
      expect(out.reuse_reason).toBe("resumed-intent");
    } finally {
      h.cleanup();
    }
  });

  it("pins 0.0.19 when the recorded version is already readable", async () => {
    const h = harness("intent");
    try {
      expect(await h.run()).toBe(0);
      expect(h.outputs()).toMatchObject({ next_version: "0.0.19", resume: "1" });
    } finally {
      h.cleanup();
    }
  });

  it("fails instead of allocating a version when the intent lookup fails", async () => {
    const h = harness("lookup-fail");
    try {
      expect(await h.run()).not.toBe(0);
      const out = h.outputs();
      expect(out.should_release).toBeUndefined();
      expect(out.next_version).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("fails instead of allocating a version when the intent cannot be downloaded", async () => {
    const h = harness("download-fail");
    try {
      expect(await h.run()).not.toBe(0);
      expect(h.outputs().should_release).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("skips when no intent exists and the payload is unchanged", async () => {
    const h = harness("unchanged");
    try {
      expect(await h.run()).toBe(0);
      expect(h.outputs()).toMatchObject({ should_release: "0", reuse_reason: "unchanged-payload" });
    } finally {
      h.cleanup();
    }
  });

  it("bumps when no intent exists and the payload is new", async () => {
    const h = harness("new");
    try {
      expect(await h.run()).toBe(0);
      const out = h.outputs();
      expect(out.should_release).toBe("1");
      expect(out.reuse_reason).toBe("new-payload");
      expect(out.resume).toBeUndefined();
      expect(out.next_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(out.next_version).not.toBe("0.0.19");
    } finally {
      h.cleanup();
    }
  });
});
