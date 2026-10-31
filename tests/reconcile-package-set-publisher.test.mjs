import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findPublisher } from '../scripts/reconcile-package-set-publisher.mjs';

const eventId = `package-set:1.2.3:${'a'.repeat(64)}`;
const pinCommit = 'b'.repeat(40);
const run = { id: 42, run_attempt: 1, display_title: `Publish CLI ${eventId}`, event: 'workflow_dispatch',
  head_branch: 'main', head_sha: pinCommit, path: '.github/workflows/publish.yml',
  repository: { full_name: 'moewolf-dev/moe-icons-cli' }, head_repository: { full_name: 'moewolf-dev/moe-icons-cli' },
  status: 'completed', conclusion: 'success' };
const find = (rows, detail = run) => findPublisher({ eventId, pinCommit, readPage: () => rows, readRun: () => detail });

test('reconciles a single exact publisher and does not accept a different pin or failed run', () => {
  assert.equal(find([]), null);
  assert.equal(find([run]), run);
  assert.equal(find([{ ...run, path: `${run.path}@refs/heads/main` }]), run);
  assert.throws(() => find([run], { ...run, path: `${run.path}@refs/heads/other` }), /exact event and pin/);
  assert.throws(() => find([run], { ...run, head_sha: 'c'.repeat(40) }), /exact event and pin/);
  assert.throws(() => find([{ ...run, conclusion: 'failure' }], { ...run, conclusion: 'failure' }), /explicit recovery/);
  assert.throws(() => find([run, run]), /ambiguous/);
  assert.throws(() => find([run], { ...run, run_attempt: 2 }), /attempt changed/);
});

test('searches all bounded pages and fails closed on an incomplete history', () => {
  const other = { display_title: 'unrelated' };
  assert.equal(findPublisher({ eventId, pinCommit, readPage: page => page === 1 ? Array(100).fill(other) : [run], readRun: () => run }), run);
  assert.throws(() => findPublisher({ eventId, pinCommit, readPage: () => Array(100).fill(other), readRun: () => run }), /search bound/);
});

test('the workflow entry point dispatches only when no exact run exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-publisher-reconcile-'));
  try {
    mkdirSync(join(dir, 'bin'));
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'bin', 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
const route = args.find(x => x.startsWith('repos/')) || '';
if (route.includes('/runs?')) console.log(JSON.stringify({ workflow_runs: process.env.TEST_EXISTING ? [${JSON.stringify(run)}] : [] }));
else if (route.endsWith('/actions/runs/42')) console.log(JSON.stringify(${JSON.stringify(run)}));
else if (route.endsWith('/git/ref/heads/main')) console.log(JSON.stringify({ object: { sha: ${JSON.stringify(pinCommit)} } }));
else if (args[0] !== 'workflow') process.exit(1);
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TEST_CALLS: log,
      GITHUB_REPOSITORY: 'moewolf-dev/moe-icons-cli', GITHUB_REF: 'refs/heads/main', EVENT_ID: eventId, PIN_COMMIT: pinCommit };
    const script = join(process.cwd(), 'scripts/reconcile-package-set-publisher.mjs');
    const first = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(log, 'utf8'), /"workflow","run"/);
    writeFileSync(log, '');
    const second = spawnSync(process.execPath, [script], { env: { ...env, TEST_EXISTING: '1' }, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /"workflow","run"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
