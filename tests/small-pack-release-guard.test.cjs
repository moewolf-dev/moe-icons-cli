const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = readFileSync(join(__dirname, '../.github/workflows/resource-pin.yml'), 'utf8');

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
