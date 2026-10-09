import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'moewolf-dev/moe-icons-cli';
const PUBLISH_WORKFLOW = '.github/workflows/publish.yml';
const RECOVERY_MARKERS = [
  'did not become installable within',
  'npm accepted submission is not yet publicly available; keep Release draft',
];

export function shouldAutoResume({ parentRun, jobs, failedLogs, priorResumeCount }) {
  if (parentRun?.path !== PUBLISH_WORKFLOW || parentRun?.head_branch !== 'main' || parentRun?.conclusion !== 'failure') {
    return { resume: false, reason: 'not a failed main publish workflow run' };
  }
  const publishJob = (jobs || []).find((job) => job.name === 'publish' && job.conclusion === 'failure');
  if (!publishJob) return { resume: false, reason: 'publish job did not fail' };
  const registryStep = (publishJob.steps || []).find((step) =>
    step.name === 'Wait for public registry visibility and smoke npx install' && step.conclusion === 'failure');
  if (!registryStep) return { resume: false, reason: 'failure was outside registry visibility verification' };
  if (!RECOVERY_MARKERS.some((marker) => String(failedLogs || '').includes(marker))) {
    return { resume: false, reason: 'failure log is not a recognized registry visibility timeout' };
  }
  if (priorResumeCount >= 1) return { resume: false, reason: 'bounded automatic resume already used' };
  return { resume: true, reason: 'registry visibility failed after immutable npm publication' };
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
