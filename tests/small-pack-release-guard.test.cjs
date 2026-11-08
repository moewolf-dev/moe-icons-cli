const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = readFileSync(join(__dirname, '../.github/workflows/resource-pin.yml'), 'utf8');
const publishWorkflow = readFileSync(join(__dirname, '../.github/workflows/publish.yml'), 'utf8');

function publishJob(name) {
  return publishWorkflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[1];
}

test('npm provenance publish stays on a GitHub-hosted runner', () => {
  // The npm registry rejects provenance bundles minted on self-hosted runners
  // (HTTP 422 "Unsupported GitHub Actions runner environment: self-hosted").
  // The signature is only available on GitHub-hosted runners, so the job that
  // runs `npm publish --provenance` must never move back to self-hosted labels.
  const publish = publishJob('publish');
  assert.ok(publish, 'publish job required');
  assert.match(publish, /npm publish "\$tgz" --access public --provenance/);
  const runsOn = publish.match(/^    runs-on: (.*)$/m)?.[1];
  assert.ok(runsOn, 'publish job must declare runs-on');
  assert.doesNotMatch(runsOn, /self-hosted/);
  assert.match(runsOn, /^(ubuntu-|\[ubuntu-)/, 'provenance publish requires a GitHub-hosted runner');
});

test('publish receipt persistence runs the gh-backed script with an explicit token', () => {
  const publish = publishJob('publish');
  assert.ok(publish, 'publish job required');
  const step = publish.match(/      - name: Preserve immutable public publish receipt for downstream replay\n([\s\S]*?)(?=^      - name:|$(?![\s\S]))/m)?.[1];
  assert.ok(step, 'receipt persistence step required');
  assert.match(step, /run: node scripts\/persist-publish-receipt\.mjs/);
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'gh needs an explicit token outside the runner default');
});

test('frozen release tag writer can use a narrowly-scoped explicit credential', () => {
  const publish = publishJob('publish');
  assert.ok(publish, 'publish job required');
  const step = publish.match(/      - name: Create or reuse draft Release and upload the candidate\n([\s\S]*?)(?=^      - name:|$(?![\s\S]))/m)?.[1];
  assert.ok(step, 'release creation step required');
  assert.match(step, /GH_TOKEN: \$\{\{ secrets\.CLI_RELEASE_WRITE_TOKEN \|\| github\.token \}\}/,
    'prefer the optional dedicated credential while preserving the default token');
  assert.equal((publish.match(/CLI_RELEASE_WRITE_TOKEN/g) ?? []).length, 1,
    'the dedicated credential may appear only in this step');
});

test('immutable candidates remain available for the full recovery window', () => {
  const pack = publishJob('pack');
  assert.ok(pack, 'candidate pack job required');
  const step = pack.match(/      - name: Upload the immutable candidate artifact\n([\s\S]*?)(?=^      - name:|$(?![\s\S]))/m)?.[1];
  assert.ok(step, 'immutable candidate artifact upload required');
  assert.match(step, /retention-days: 90\b/, 'candidate artifact must outlive short repository defaults');
  assert.equal((step.match(/^\s+retention-days:/gm) ?? []).length, 1,
    'artifact retention must have one unambiguous YAML value');
});

function workflowJobs(text) {
  const jobs = {};
  let current = null;
  let step = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (head) { current = head[1]; jobs[current] = []; step = null; continue; }
    if (current === null) continue;
    if (/^      - /.test(line)) { step = [line]; jobs[current].push(step); continue; }
    if (step) step.push(line);
  }
  return jobs;
}

test('every job that runs repository scripts repairs the workspace first', () => {
  // The shared self-hosted runner workspace can end up reporting the exact SHA
  // while tracked files are absent (failed sparse-checkout, index bits, or a
  // half-cleaned tree). Any job that then shells out to `.github/scripts/...`
  // or `scripts/...` dies on a missing file, including recovery jobs, so each
  // such job must run the repair step before its first repository script.
  const directory = join(__dirname, '../.github/workflows');
  for (const name of readdirSync(directory).filter(file => file.endsWith('.yml'))) {
    const jobs = workflowJobs(readFileSync(join(directory, name), 'utf8'));
    for (const [job, steps] of Object.entries(jobs)) {
      const texts = steps.map(step => step.join('\n'));
      const needsRepair = texts.findIndex(text => /(node scripts\/|bash \.github\/scripts|node \.github\/scripts)/.test(text));
      if (needsRepair < 0) continue;
      const repairs = texts.findIndex(text => text.includes('- name: Repair a sparse or incomplete runner workspace'));
      assert.ok(repairs >= 0, `${name}:${job} runs a repository script without a workspace repair step`);
      assert.ok(repairs < needsRepair, `${name}:${job} must repair the workspace before running a repository script`);
      // `git add` refuses tracked paths outside a sparse definition, so the
      // repair must drop the sparse state, not only re-materialise the files.
      assert.match(texts[repairs], /core\.sparseCheckout/, `${name}:${job} repair step must clear sparse-checkout state`);
    }
  }
});

test('no workflow sparse-checks out the shared workspace root', () => {
  // Sparse-checkout state lives in the shared workspace git dir. Sparse-checking
  // out the main repository (no `path:`) poisons every later job on that runner;
  // sparse checkouts are only allowed for extra checkouts into a subdirectory.
  const directory = join(__dirname, '../.github/workflows');
  for (const name of readdirSync(directory).filter(file => file.endsWith('.yml'))) {
    const lines = readFileSync(join(directory, name), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/^\s+- uses: actions\/checkout@/.test(line)) return;
      const indent = line.match(/^\s*/)[0];
      let end = index + 1;
      while (end < lines.length && !new RegExp(`^${indent}- `).test(lines[end])) end += 1;
      const block = lines.slice(index, end).join('\n');
      if (!/sparse-checkout:/.test(block)) return;
      assert.match(block, /^\s+path:/m, `${name}: main-repo checkout must not use sparse-checkout`);
    });
  }
});

test('legacy aggregate pin input is rejected before checkout, secrets, or asset transfer', () => {
  const job = workflow.match(/^  small-pack-policy:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];
  assert.ok(job, 'legacy-entry policy job required');
  assert.match(job, /^    if: github\.event\.action != 'moe-icons-package-set-release'$/m);
  assert.match(job, /^    permissions: \{\}$/m);
  assert.doesNotMatch(job, /uses:|secrets\.|curl|wget|gh api|download-artifact|upload-artifact/);
  const script = job.match(/        run: \|\n([\s\S]*)/)?.[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const temp = mkdtempSync(join(tmpdir(), 'cli-pin-guard-'));
  try {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: temp, encoding: 'utf8' });
    assert.equal(result.status, 78);
    assert.match(result.stdout, /candidate-set metadata packages/);
    assert.deepEqual(readdirSync(temp), []);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('package-set pin requires the exact repository, dispatch action, and explicit writer switch', () => {
  const job = workflow.match(/^  package-set-pin:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];
  assert.ok(job, 'package-set receiver job required');
  const condition = job.match(/^    if: (.*)$/m)?.[1];
  assert.ok(condition);
  for (const required of [
    "github.repository == 'moewolf-dev/moe-icons-cli'",
    "github.event_name == 'repository_dispatch'",
    "github.event.action == 'moe-icons-package-set-release'",
    "vars.MOEICONS_AUTO_RELEASE_ENABLED == 'true'",
  ]) assert.ok(condition.includes(required), `missing condition ${required}`);
  assert.match(condition, /&&/);
});

test('legacy aggregate pin writer remains hard-disabled independently of the new receiver', () => {
  const job = workflow.match(/^  pin:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];
  assert.ok(job, 'legacy pin job required');
  assert.match(job, /^    if: false$/m);
  assert.match(job, /^    needs: \[small-pack-policy\]$/m);
});
