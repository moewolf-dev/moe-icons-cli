#!/usr/bin/env node
// Reconcile the exact event before asking Actions to publish an immutable version.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = 'moewolf-dev/moe-icons-cli';
const WORKFLOW = '.github/workflows/publish.yml';
function assert(ok, message) { if (!ok) throw new Error(message); }

export function findPublisher({ eventId, pinCommit, readPage, readRun }) {
  assert(/^package-set:[0-9]+\.[0-9]+\.[0-9]+:[a-f0-9]{64}$/.test(eventId || ''), 'invalid package-set event ID');
  assert(/^[a-f0-9]{40}$/.test(pinCommit || ''), 'invalid pin commit');
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const rows = readPage(page);
    assert(Array.isArray(rows) && rows.length <= 100, 'invalid publisher run listing');
    matches.push(...rows.filter(row => row.display_title === `Publish CLI ${eventId}`));
    if (rows.length < 100) break;
    assert(page < 10, 'publisher run history exceeds search bound');
  }
  assert(matches.length <= 1, 'ambiguous publisher runs for package-set event');
  if (!matches.length) return null;
  const listed = matches[0];
  assert(/^[1-9]\d*$/.test(String(listed.id)), 'invalid publisher run ID');
  const run = readRun(listed.id);
  for (const row of [listed, run]) {
    assert(String(row.id) === String(listed.id) && row.display_title === `Publish CLI ${eventId}`
      && row.event === 'workflow_dispatch' && row.head_branch === 'main'
      && [WORKFLOW, `${WORKFLOW}@main`, `${WORKFLOW}@refs/heads/main`].includes(row.path)
      && row.repository?.full_name === REPO && row.head_repository?.full_name === REPO
      && row.head_sha === pinCommit && Number.isSafeInteger(row.run_attempt) && row.run_attempt > 0,
    'existing publisher does not bind the exact event and pin');
  }
  assert(run.run_attempt === listed.run_attempt, 'publisher attempt changed during reconciliation');
  assert(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'].includes(run.status), 'invalid publisher status');
  if (run.status === 'completed') assert(run.conclusion === 'success', 'existing publisher failed; explicit recovery is required');
  return run;
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert(result.status === 0 && !result.error, `GitHub request failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

function main() {
  assert(process.env.GITHUB_REPOSITORY === REPO && process.env.GITHUB_REF === 'refs/heads/main', 'trusted CLI main run required');
  const eventId = process.env.EVENT_ID, pinCommit = process.env.PIN_COMMIT;
  const read = route => JSON.parse(gh(['api', '--hostname', 'github.com', `repos/${REPO}/${route}`]));
  const existing = findPublisher({ eventId, pinCommit,
    readPage: page => read(`actions/workflows/publish.yml/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`).workflow_runs,
    readRun: id => read(`actions/runs/${id}`) });
  if (existing) { process.stdout.write(`Reusing publisher run ${existing.id}\n`); return; }
  const live = read('git/ref/heads/main');
  assert(live?.object?.sha === pinCommit, 'main drifted after pin; refusing publisher dispatch');
  gh(['workflow', 'run', 'publish.yml', '--repo', REPO, '--ref', 'main', '-f', 'npm_auth_mode=oidc',
    '-f', 'dry_run=false', '-f', 'break_glass=PUBLISH', '-f', `correlation_id=${eventId}`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
