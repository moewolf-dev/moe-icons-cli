import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'moewolf-dev/moe-icons-cli';
const PUBLISH_WORKFLOW = '.github/workflows/publish.yml';
const RECOVERY_MARKERS = [
  'did not become installable within',
  'npm accepted submission is not yet publicly available; keep Release draft',
];
const POST_VISIBILITY_FINALIZATION_STEPS = new Set([
  'Finalize the Release',
  'Write the canonical publish receipt',
  'Upload the publish receipt',
  'Preserve immutable public publish receipt for downstream replay',
]);

export function shouldAutoResume({ parentRun, jobs, failedLogs, priorResumeCount }) {
  if (parentRun?.path !== PUBLISH_WORKFLOW || parentRun?.head_branch !== 'main' || parentRun?.conclusion !== 'failure') {
    return { resume: false, reason: 'not a failed main publish workflow run' };
  }
  if (/\bresume:\s*\d+\b/.test(String(parentRun.display_title || ''))) {
    return { resume: false, reason: 'this publish run is already an automatic resume' };
  }
  const publishJob = (jobs || []).find((job) => job.name === 'publish' && job.conclusion === 'failure');
  if (!publishJob) return { resume: false, reason: 'publish job did not fail' };
  const steps = publishJob.steps || [];
  const failedStep = steps.find((step) => step.conclusion === 'failure');
  if (!failedStep) return { resume: false, reason: 'publish failure step is unavailable' };
  const succeeded = (name) => steps.some((step) => step.name === name && step.conclusion === 'success');
  const registryStep = steps.find((step) =>
    step.name === 'Wait for public registry visibility and smoke npx install' && step.conclusion === 'failure');
  let recoveryReason;
  if (registryStep && failedStep.name === registryStep.name) {
    if (!succeeded('Publish to npm or verify the existing registry package')) {
      return { resume: false, reason: 'immutable package publication step did not succeed' };
    }
    if (!RECOVERY_MARKERS.some((marker) => String(failedLogs || '').includes(marker))) {
      return { resume: false, reason: 'failure log is not a recognized registry visibility timeout' };
    }
    recoveryReason = 'registry visibility failed after immutable npm publication';
  } else if (POST_VISIBILITY_FINALIZATION_STEPS.has(failedStep.name)) {
    if (!succeeded('Publish to npm or verify the existing registry package') ||
        !succeeded('Wait for public registry visibility and smoke npx install')) {
      return { resume: false, reason: 'npm publication and public visibility were not both verified' };
    }
    recoveryReason = `public npm package verified; resume failed finalization step: ${failedStep.name}`;
  } else {
    return { resume: false, reason: 'failure was outside verified publication finalization' };
  }
  if (priorResumeCount >= 1) return { resume: false, reason: 'bounded automatic resume already used' };
  return { resume: true, reason: recoveryReason };
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN, GH_PROMPT_DISABLED: '1' },
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  }));
}

function gh(args) {
  execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN, GH_PROMPT_DISABLED: '1' },
    timeout: 30_000,
  });
}

export function main(env = process.env) {
  const runId = String(env.WORKFLOW_RUN_ID || '');
  if (!/^[1-9]\d*$/.test(runId)) throw new Error('WORKFLOW_RUN_ID must be a positive integer');
  const parentRun = ghJson(['api', `repos/${REPOSITORY}/actions/runs/${runId}`]);
  const jobs = ghJson(['api', `repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`]).jobs || [];
  let logs = '';
  const failedLogs = execFileSync('gh', ['run', 'view', runId, '--repo', REPOSITORY, '--log-failed'], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: env.GITHUB_TOKEN, GH_PROMPT_DISABLED: '1' },
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  logs = failedLogs;
  const allRuns = ghJson(['api', `repos/${REPOSITORY}/actions/workflows/publish.yml/runs?per_page=100`]).workflow_runs || [];
  const priorResumeCount = allRuns.filter((run) =>
    run.event === 'workflow_dispatch' && String(run.display_title || '').includes(`resume:${runId}`)).length;
  const decision = shouldAutoResume({ parentRun, jobs, failedLogs: logs, priorResumeCount });
  if (!decision.resume) {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
    return decision;
  }
  gh(['workflow', 'run', 'publish.yml', '--repo', REPOSITORY, '--ref', 'main',
    '-f', `resume_run_id=${runId}`, '-f', 'npm_auth_mode=oidc', '-f', 'dry_run=false', '-f', 'break_glass=PUBLISH']);
  const output = { ...decision, resumedRunId: runId, retryLimit: 1 };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
