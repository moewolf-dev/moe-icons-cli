const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = readFileSync(join(__dirname, '../.github/workflows/resource-pin.yml'), 'utf8');
test('retired CLI resource pin is disabled independently of policy result and writer switches', () => {
  const job = workflow.match(/^  pin:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];
  assert.ok(job, 'pin job required');
  assert.match(job, /^    if: false$/m);
  assert.match(job, /^    needs: \[small-pack-policy\]$/m);
  assert.equal((job.match(/^    if:/gm) || []).length, 1);
});
test('policy job rejects before checkout, secret use or asset transfer', () => {
  const job = workflow.match(/^  small-pack-policy:\n([\s\S]*?)(?=^  [\w-]+:)/m)?.[1];
  assert.ok(job); assert.match(job, /^    permissions: \{\}$/m);
  assert.doesNotMatch(job, /uses:|secrets\.|curl|wget|gh api|download-artifact|upload-artifact/);
  const script = job.match(/        run: \|\n([\s\S]*)/)?.[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const temp = mkdtempSync(join(tmpdir(), 'cli-pin-guard-'));
  try {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: temp, encoding: 'utf8', env: { PATH: process.env.PATH, MOEICONS_AUTO_RELEASE_ENABLED: 'true' } });
    assert.equal(result.status, 78); assert.match(result.stdout, /::error::/);
    assert.deepEqual(readdirSync(temp), []);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
