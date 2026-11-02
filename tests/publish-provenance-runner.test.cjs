const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const workflow = readFileSync(join(__dirname, '../.github/workflows/publish.yml'), 'utf8');

function job(name) {
  return workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[1];
}

test('npm provenance publish stays on a GitHub-hosted runner', () => {
  // The npm registry rejects provenance bundles minted on self-hosted runners
  // (HTTP 422 "Unsupported GitHub Actions runner environment: self-hosted").
  // The signature is only available on GitHub-hosted runners, so the job that
  // runs `npm publish --provenance` must never move back to self-hosted labels.
  const publish = job('publish');
  assert.ok(publish, 'publish job required');
  assert.match(publish, /npm publish "\$tgz" --access public --provenance/);
  const runsOn = publish.match(/^    runs-on: (.*)$/m)?.[1];
  assert.ok(runsOn, 'publish job must declare runs-on');
  assert.doesNotMatch(runsOn, /self-hosted/);
  assert.match(runsOn, /^(ubuntu-|\[ubuntu-)/, 'provenance publish requires a GitHub-hosted runner');
});

test('publish receipt persistence runs the gh-backed script with an explicit token', () => {
  const publish = job('publish');
  assert.ok(publish, 'publish job required');
  const step = publish.match(/      - name: Preserve immutable public publish receipt for downstream replay\n([\s\S]*?)(?=^      - name:|$(?![\s\S]))/m)?.[1];
  assert.ok(step, 'receipt persistence step required');
  assert.match(step, /run: node scripts\/persist-publish-receipt\.mjs/);
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'gh needs an explicit token outside the runner default');
});
