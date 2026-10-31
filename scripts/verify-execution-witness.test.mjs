import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyExecutionWitness } from './verify-execution-witness.mjs';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const bytes = value => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const sha = value => createHash('sha256').update(value).digest('hex');

test('canonical reused roots are tied to the registry and exact execution before consumers proceed', () => {
  const binding = { sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), resourceVersion: '1.0.0', free: { packageSetSha256: 'c'.repeat(64), candidateRootSha256: 'd'.repeat(64), candidateRootBytes: 100 }, pro: { packageSetSha256: 'e'.repeat(64), candidateRootSha256: 'f'.repeat(64), candidateRootBytes: 200 } };
  const producer = { runId: '10', runAttempt: 2, headSha: '8'.repeat(40) }, sourceDispatchId = '9'.repeat(64);
  const projection = { schemaVersion: 2, sourceCommit: binding.sourceCommit, sourceVersion: binding.resourceVersion, sourceContentHash: '1'.repeat(64), sourceIndexSha256: '2'.repeat(64), sourceProducer: { runId: '3', runAttempt: 1 }, sourceReleaseAttempt: 1, generatorCommit: binding.generatorCommit, producer: { runId: '4', runAttempt: 1 }, candidateSets: { free: binding.free.packageSetSha256, pro: binding.pro.packageSetSha256 } };
  const record = { ...projection, recordSha256: sha(bytes(projection)) };
  const witness = { schemaVersion: 1, sourceCommit: binding.sourceCommit, sourceDispatchId, registrySha256: record.recordSha256, producer, candidates: { free: binding.free, pro: binding.pro } };
  const payloads = [bytes(record), bytes(witness)];
  const assets = payloads.map((data, index) => ({ id: index + 1, name: index ? 'execution-10-2.json' : 'source-candidate.json', state: 'uploaded', size: data.length, digest: `sha256:${sha(data)}` }));
  const tag = `candidate-source-v2-${binding.sourceCommit}`;
  const api = route => route.endsWith('/moe-icons-code-library') ? { full_name: 'moewolf-dev/moe-icons-code-library', private: true, default_branch: 'main' } : route.includes('/releases/tags/') ? { id: 1, tag_name: tag, draft: false, prerelease: true } : assets;
  const download = asset => payloads[asset.id - 1];
  const dir = mkdtempSync(join(tmpdir(), 'witness-meter-')), previous = process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT;
  process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT = join(dir, 'report.json');
  try {
    assert.equal(verifyExecutionWitness({ binding, producer, sourceDispatchId, api, download }).record.recordSha256, record.recordSha256);
    const report = JSON.parse(readFileSync(process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT));
    assert.equal(report.totals.responseBytes, payloads[0].length + payloads[1].length);
    assert.equal(report.totals.verifiedDownloads, 2);
    assert.equal(report.complete, false);
    assert.ok(report.bypassRisk.includes('unmeasured-github-api'));
    const apiRaw = route => Buffer.from(JSON.stringify(api(route)));
    assert.equal(verifyExecutionWitness({ binding, producer, sourceDispatchId, api, apiRaw, download }).record.recordSha256, record.recordSha256);
    const measured = JSON.parse(readFileSync(process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT));
    const expectedApiBytes = [
      'repos/moewolf-dev/moe-icons-code-library',
      `repos/moewolf-dev/moe-icons-code-library/releases/tags/${tag}`,
      'repos/moewolf-dev/moe-icons-code-library/releases/1/assets?per_page=100&page=1',
    ].reduce((sum, route) => sum + apiRaw(route).length, 0);
    assert.equal(measured.totals.responseBytes, payloads[0].length + payloads[1].length + expectedApiBytes);
    assert.ok(!measured.bypassRisk.includes('unmeasured-github-api'));
    assert.ok(measured.bypassRisk.includes('partial-consumer-scope'));
    assert.throws(() => verifyExecutionWitness({ binding, producer, sourceDispatchId, api, apiRaw: () => { throw Error('API unavailable'); }, download }));
    const failedApi = JSON.parse(readFileSync(process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT));
    assert.equal(failedApi.totals.unknownResponses, 1);
    assert.equal(failedApi.entries[0].responseBytes, null);
    assert.throws(() => verifyExecutionWitness({ binding, producer, sourceDispatchId, api, download: () => { throw Error('network failure'); } }));
    const failed = JSON.parse(readFileSync(process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT));
    assert.equal(failed.totals.unknownResponses, 1);
    assert.equal(failed.entries[0].responseBytes, null);
  } finally {
    if (previous === undefined) delete process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT; else process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => verifyExecutionWitness({ binding: { ...binding, pro: { ...binding.pro, candidateRootSha256: '0'.repeat(64) } }, producer, sourceDispatchId, api, download }), /root mismatch/);
  assert.throws(() => verifyExecutionWitness({ binding, producer: { ...producer, headSha: '0'.repeat(40) }, sourceDispatchId, api, download }), /execution identity mismatch/);
});
