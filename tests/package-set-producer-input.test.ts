import { it } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function event() {
  const delivery: Record<string, any> = {
    schemaVersion: 1,
    sourceDispatchId: "1".repeat(64),
    resourceVersion: "1.2.3",
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    producer: { repository: "moewolf-dev/moe-icons-code-library", workflowPath: ".github/workflows/small-pack-candidate.yml", runId: "123", runAttempt: 2, headSha: "b".repeat(40) },
    free: { packageSetSha256: "c".repeat(64), candidateRootSha256: "d".repeat(64), candidateRootBytes: 512 },
    pro: { packageSetSha256: "e".repeat(64), candidateRootSha256: "f".repeat(64), candidateRootBytes: 768 },
  };
  const id = hash(`moe-icons-small-package-plugin-v1\n${delivery.sourceDispatchId}\n${delivery.free.packageSetSha256}\n${delivery.pro.packageSetSha256}\n`);
  delivery.eventId = `package-set:${delivery.resourceVersion}:${id}`;
  return { action: "moe-icons-package-set-release", client_payload: { eventId: delivery.eventId, delivery } };
}

async function makeHarness(jobConclusion = "success", displayTitle = `Source package-set ${"a".repeat(40)} ${"1".repeat(64)}`, jobPages: Record<number, any> | null = null) {
  const root = await mkdtemp(join(tmpdir(), "moe-plugin-package-set-input-"));
  await mkdir(join(root, "bin"));
  const ghPath = join(root, "bin/gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const route=process.argv[process.argv.indexOf('api')+1]||'';
const repo='moewolf-dev/moe-icons-code-library', commit='${"b".repeat(40)}';
const pages=${JSON.stringify(jobPages)};
if(route.includes('/jobs?')) { const page=Number(new URL('https://api.test/?'+route.split('?')[1]).searchParams.get('page')); console.log(JSON.stringify(pages?.[page]??{total_count:4,jobs:['durable','dispatch-free','dispatch-pro','dispatch-website'].map(name=>({name,conclusion:'${jobConclusion}'}))})); }
else console.log(JSON.stringify({id:123,run_attempt:2,event:'workflow_dispatch',status:'completed',conclusion:'success',head_sha:commit,head_branch:'main',path:'.github/workflows/small-pack-candidate.yml',display_title:${JSON.stringify(displayTitle)},repository:{full_name:repo},head_repository:{full_name:repo}}));
`, { mode: 0o755 });
  const payloadPath = join(root, "event.json");
  await writeFile(payloadPath, JSON.stringify(event()));
  const envFile = join(root, "github-env");
  await writeFile(envFile, "");
  return { root, payloadPath, envFile, ghPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

it("verifies the exact Generator attempt and writes a binding without artifact payloads", async () => {
  const h = await makeHarness();
  try {
    const outputRoot = join(h.root, "output");
    await run(process.execPath, ["scripts/verify-package-set-input.mjs", outputRoot], {
      env: { ...process.env, PATH: `${join(h.root, "bin")}:${process.env.PATH}`, GH_TOKEN: "read-token", GITHUB_EVENT_PATH: h.payloadPath, GITHUB_ENV: h.envFile },
    });
    const binding = JSON.parse(await readFile(join(outputRoot, "package-set-binding.json"), "utf8"));
    const ledgerEvent = JSON.parse(await readFile(join(outputRoot, "event.json"), "utf8"));
    assert.equal(binding.resourceVersion, "1.2.3");
    assert.equal(binding.free.packageSetSha256, "c".repeat(64));
    assert.equal(ledgerEvent.sourceDispatchId, "1".repeat(64));
    assert.equal(ledgerEvent.producer.runAttempt, 2);
    assert.match(await readFile(h.envFile, "utf8"), /RESOURCE_VERSION=1\.2\.3/);
  } finally { await h.cleanup(); }
});

it("rejects a candidate producer whose package-set or projection job failed", async () => {
  const h = await makeHarness("failure");
  try {
    const outputRoot = join(h.root, "output");
    await assert.rejects(run(process.execPath, ["scripts/verify-package-set-input.mjs", outputRoot], {
      env: { ...process.env, PATH: `${join(h.root, "bin")}:${process.env.PATH}`, GH_TOKEN: "read-token", GITHUB_EVENT_PATH: h.payloadPath, GITHUB_ENV: h.envFile },
    }), /producer job durable did not succeed/);
    await assert.rejects(readFile(join(outputRoot, "event.json")), /ENOENT/);
  } finally { await h.cleanup(); }
});

it("finds required producer jobs on page two and rejects a changing job count", async () => {
  const pages = {
    1: { total_count: 104, jobs: Array.from({ length: 100 }, (_, index) => ({ name: `build-unit-${index}` })) },
    2: { total_count: 104, jobs: ["durable", "dispatch-free", "dispatch-pro", "dispatch-website"].map(name => ({ name, conclusion: "success" })) },
  };
  const h = await makeHarness("success", undefined, pages);
  try {
    const outputRoot = join(h.root, "output");
    await run(process.execPath, ["scripts/verify-package-set-input.mjs", outputRoot], {
      env: { ...process.env, PATH: `${join(h.root, "bin")}:${process.env.PATH}`, GH_TOKEN: "read-token", GITHUB_EVENT_PATH: h.payloadPath, GITHUB_ENV: h.envFile },
    });
    assert.ok(JSON.parse(await readFile(join(outputRoot, "event.json"), "utf8")));
  } finally { await h.cleanup(); }

  const changedPages = {
    1: { total_count: 101, jobs: Array.from({ length: 100 }, (_, index) => ({ name: `build-unit-${index}` })) },
    2: { total_count: 104, jobs: ["durable", "dispatch-free", "dispatch-pro", "dispatch-website"].map(name => ({ name, conclusion: "success" })) },
  };
  const changed = await makeHarness("success", undefined, changedPages);
  try {
    await assert.rejects(run(process.execPath, ["scripts/verify-package-set-input.mjs", join(changed.root, "output")], {
      env: { ...process.env, PATH: `${join(changed.root, "bin")}:${process.env.PATH}`, GH_TOKEN: "read-token", GITHUB_EVENT_PATH: changed.payloadPath, GITHUB_ENV: changed.envFile },
    }), /job count changed between pages/);
  } finally { await changed.cleanup(); }
});

it("rejects a Generator run title bound to another Source commit or dispatch ID", async () => {
  for (const title of [
    `Source package-set ${"9".repeat(40)} ${"1".repeat(64)}`,
    `Source package-set ${"a".repeat(40)} ${"9".repeat(64)}`,
  ]) {
    const h = await makeHarness("success", title);
    try {
      await assert.rejects(run(process.execPath, ["scripts/verify-package-set-input.mjs", join(h.root, "output")], {
        env: { ...process.env, PATH: `${join(h.root, "bin")}:${process.env.PATH}`, GH_TOKEN: "read-token", GITHUB_EVENT_PATH: h.payloadPath, GITHUB_ENV: h.envFile },
      }), /exact Source\/Generator binding/);
    } finally { await h.cleanup(); }
  }
});
