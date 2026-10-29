import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  assert.equal(verifyExecutionWitness({ binding, producer, sourceDispatchId, api, download }).record.recordSha256, record.recordSha256);
  assert.throws(() => verifyExecutionWitness({ binding: { ...binding, pro: { ...binding.pro, candidateRootSha256: '0'.repeat(64) } }, producer, sourceDispatchId, api, download }), /root mismatch/);
  assert.throws(() => verifyExecutionWitness({ binding, producer: { ...producer, headSha: '0'.repeat(40) }, sourceDispatchId, api, download }), /execution identity mismatch/);
});
