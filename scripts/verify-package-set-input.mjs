#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { workflowRunPathMatches } from "./workflow-run-path.cjs";
import { verifyExecutionWitness } from "./verify-execution-witness.mjs";

const fail = message => { throw new Error(`package-set producer verification: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const HEX = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SOURCE_REPOSITORY = "moewolf-dev/moe-icons-code-library";
const SOURCE_WORKFLOW = ".github/workflows/small-pack-candidate.yml";
const MAX_GENERATOR_JOBS = 300;
const MAX_GENERATOR_JOB_PAGES = 3;

function exactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(","), `${label} has unexpected or missing fields`);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function gh(route) {
  try { return JSON.parse(execFileSync("gh", ["api", route], { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 })); }
  catch { fail("exact package-set producer evidence is unavailable"); }
}

function readProducerJobs(runId, runAttempt) {
  const jobs = [];
  let totalCount;
  for (let page = 1; page <= MAX_GENERATOR_JOB_PAGES; page += 1) {
    const result = gh(`repos/${SOURCE_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`);
    assert(result && Number.isSafeInteger(result.total_count) && result.total_count >= 0
      && result.total_count <= MAX_GENERATOR_JOBS && Array.isArray(result.jobs) && result.jobs.length <= 100,
    "package-set producer jobs are incomplete or exceed the 300-job bound");
    if (totalCount === undefined) totalCount = result.total_count;
    assert(result.total_count === totalCount, "package-set producer job count changed between pages");
    jobs.push(...result.jobs);
    if (jobs.length >= totalCount) break;
    assert(page < MAX_GENERATOR_JOB_PAGES, "package-set producer jobs exceed the page bound");
  }
  assert(jobs.length === totalCount, "package-set producer job listing is incomplete");
  return jobs;
}

function validateBinding(raw, tier, delivery) {
  exactKeys(raw, ["packageSetSha256", "candidateRootSha256", "candidateRootBytes"], `${tier} candidate binding`);
  assert(HEX.test(raw.packageSetSha256 || "") && HEX.test(raw.candidateRootSha256 || "")
    && Number.isSafeInteger(raw.candidateRootBytes) && raw.candidateRootBytes > 0 && raw.candidateRootBytes <= 1024 * 1024,
  `${tier} candidate binding is invalid`);
  return { ...raw };
}

function verifyProducer(producer, sourceCommit, sourceDispatchId) {
  exactKeys(producer, ["repository", "workflowPath", "runId", "runAttempt", "headSha"], "package-set producer");
  assert(producer.repository === SOURCE_REPOSITORY && producer.workflowPath === SOURCE_WORKFLOW
    && /^[1-9]\d*$/.test(String(producer.runId)) && Number.isSafeInteger(producer.runAttempt) && producer.runAttempt > 0
    && COMMIT.test(producer.headSha || ""), "package-set producer locator is invalid");
  const attempt = gh(`repos/${SOURCE_REPOSITORY}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`);
  assert(workflowRunPathMatches(attempt, SOURCE_WORKFLOW) && attempt.repository?.full_name === SOURCE_REPOSITORY
    && attempt.head_repository?.full_name === SOURCE_REPOSITORY && attempt.head_branch === "main"
    && ["workflow_dispatch", "repository_dispatch"].includes(attempt.event)
    && String(attempt.id) === String(producer.runId) && Number(attempt.run_attempt) === producer.runAttempt
    && attempt.head_sha === producer.headSha
    && attempt.display_title === `Source package-set ${sourceCommit} ${sourceDispatchId}`,
  "package-set producer run identity differs from its exact Source/Generator binding");
  const jobs = readProducerJobs(producer.runId, producer.runAttempt);
  for (const name of ["durable", "dispatch-free", "dispatch-pro", "dispatch-website"]) {
    const matches = jobs.filter(job => job.name === name);
    assert(matches.length === 1 && matches[0].conclusion === "success", `producer job ${name} did not succeed`);
  }
  return { repository: producer.repository, workflowPath: producer.workflowPath, runId: String(producer.runId), runAttempt: producer.runAttempt, headSha: producer.headSha };
}

async function main() {
  const eventFile = process.env.GITHUB_EVENT_PATH;
  const outputRoot = resolve(process.argv[2] || "");
  assert(process.env.GH_TOKEN && eventFile && process.argv[2], "GH_TOKEN, event payload, and output directory are required");
  const githubEvent = JSON.parse(await readFile(eventFile, "utf8"));
  assert(githubEvent.action === "moe-icons-package-set-release", "unexpected repository dispatch type");
  const envelope = githubEvent.client_payload;
  exactKeys(envelope, ["eventId", "delivery"], "dispatch envelope");
  const delivery = envelope.delivery;
  exactKeys(delivery, ["schemaVersion", "eventId", "sourceDispatchId", "resourceVersion", "sourceCommit", "generatorCommit", "producer", "free", "pro"], "package-set delivery");
  assert(delivery.schemaVersion === 1 && delivery.eventId === envelope.eventId
    && HEX.test(delivery.sourceDispatchId || "") && VERSION.test(delivery.resourceVersion || "")
    && COMMIT.test(delivery.sourceCommit || "") && COMMIT.test(delivery.generatorCommit || ""), "package-set delivery identity is invalid");
  const producer = verifyProducer(delivery.producer, delivery.sourceCommit, delivery.sourceDispatchId);
  const free = validateBinding(delivery.free, "free", delivery);
  const pro = validateBinding(delivery.pro, "pro", delivery);
  assert(free.packageSetSha256 !== pro.packageSetSha256, "Free and Pro package sets must be distinct");
  if (producer.headSha !== delivery.generatorCommit) verifyExecutionWitness({ binding: { ...delivery, free, pro }, producer, sourceDispatchId: delivery.sourceDispatchId, api: gh });
  const idDigest = sha256(`moe-icons-small-package-plugin-v1\n${delivery.sourceDispatchId}\n${free.packageSetSha256}\n${pro.packageSetSha256}\n`);
  const eventId = `package-set:${delivery.resourceVersion}:${idDigest}`;
  assert(delivery.eventId === eventId, "package-set event ID does not bind Source and both exact candidate sets");

  const bindings = { schemaVersion: 1, resourceVersion: delivery.resourceVersion, sourceCommit: delivery.sourceCommit, generatorCommit: delivery.generatorCommit, free, pro };
  const event = {
    schemaVersion: 1,
    eventId,
    sourceRepository: SOURCE_REPOSITORY,
    sourceVersion: delivery.resourceVersion,
    sourceCommit: delivery.sourceCommit,
    resourceVersion: delivery.resourceVersion,
    generatorCommit: delivery.generatorCommit,
    sourceDispatchId: delivery.sourceDispatchId,
    packageSets: bindings,
    producer,
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, "package-set-binding.json"), `${JSON.stringify(bindings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(outputRoot, "event.json"), `${JSON.stringify(event, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const env = ["EVENT_ID", eventId, "RESOURCE_VERSION", delivery.resourceVersion, "SOURCE_COMMIT", delivery.sourceCommit, "GENERATOR_COMMIT", delivery.generatorCommit, "SOURCE_DISPATCH_ID", delivery.sourceDispatchId, "UPSTREAM_RUN_ID", producer.runId, "UPSTREAM_RUN_ATTEMPT", String(producer.runAttempt)];
  for (let index = 0; index < env.length; index += 2) await writeFile(process.env.GITHUB_ENV, `${env[index]}=${env[index + 1]}\n`, { flag: "a" });
  process.stdout.write(`verified ${delivery.resourceVersion} Free/Pro package-set bindings from run ${producer.runId}\n`);
}

try { await main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "package-set producer verification failed"}\n`); process.exitCode = 1; }
