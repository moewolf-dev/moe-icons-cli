import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import transportTools from './small-pack-consumer-transport.cjs';

const REPO = 'moewolf-dev/moe-icons-code-library', HEX = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const assert = (ok, message) => { if (!ok) throw Error(`execution witness: ${message}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const bytes = value => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function verifyExecutionWitness(options) {
  const reportPath = process.env.SMALL_PACK_WITNESS_TRANSPORT_REPORT;
  const recorder = reportPath ? transportTools.createRecorder({ scope: 'execution-witness-read' }) : null;
  // This recorder measures asset bodies only; the GitHub JSON API lookups are
  // deliberately marked unknown until the complete consumer meter covers them.
  if (recorder) recorder.risk('unmeasured-github-api');
  try { return verifyWitness(options, recorder); }
  finally { if (recorder) transportTools.writeReport(reportPath, recorder.report()); }
}

function verifyWitness({ binding, producer, sourceDispatchId, api, download }, recorder) {
  assert(binding && COMMIT.test(binding.sourceCommit || '') && COMMIT.test(binding.generatorCommit || '')
    && HEX.test(sourceDispatchId || '') && /^[1-9]\d*$/.test(String(producer?.runId))
    && Number.isSafeInteger(producer?.runAttempt) && producer.runAttempt > 0 && COMMIT.test(producer.headSha || '')
    && typeof api === 'function', 'exact identity required');
  const tag = `candidate-source-v2-${binding.sourceCommit}`;
  const repo = api(`repos/${REPO}`);
  assert(repo.full_name === REPO && repo.private === true && repo.default_branch === 'main', 'private repository authority mismatch');
  const release = api(`repos/${REPO}/releases/tags/${tag}`);
  assert(release.tag_name === tag && release.draft === false && release.prerelease === true
    && Number.isSafeInteger(release.id) && release.id > 0, 'registry release mismatch');
  const assets = [];
  for (let page = 1; page <= 10; page++) {
    const list = api(`repos/${REPO}/releases/${release.id}/assets?per_page=100&page=${page}`);
    assert(Array.isArray(list) && list.length <= 100, 'asset page invalid');
    assets.push(...list); assert(assets.length <= 900, 'asset budget exceeded');
    if (list.length < 100) break;
    assert(page < 10, 'asset pagination exceeded');
  }
  const fetchAsset = name => {
    const matches = assets.filter(asset => asset.name === name); assert(matches.length === 1, 'asset missing or ambiguous');
    const asset = matches[0];
    assert(asset.state === 'uploaded' && Number.isSafeInteger(asset.id) && asset.id > 0 && Number.isSafeInteger(asset.size)
      && asset.size > 0 && asset.size <= 1024 * 1024 && /^sha256:[a-f0-9]{64}$/.test(asset.digest || ''), 'asset metadata invalid');
    let data;
    try {
      data = download ? download(asset) : execFileSync('gh', ['api', `repos/${REPO}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { timeout: 30000, maxBuffer: 1024 * 1024 });
      assert(Buffer.isBuffer(data) && data.length === asset.size && `sha256:${sha256(data)}` === asset.digest, 'asset readback mismatch');
    } catch (error) {
      const delivered = Buffer.isBuffer(data) ? data.length : Buffer.isBuffer(error.stdout) ? error.stdout.length : null;
      recorder?.record({ callId: name, route: 'github-release-asset', attempt: 1, status: 'failed',
        responseBytes: null, deliveredBytes: delivered, expectedBytes: asset.size, errorClass: 'asset-read-or-digest' });
      throw error;
    }
    recorder?.record({ callId: name, route: 'github-release-asset', attempt: 1, status: 'complete',
      responseBytes: data.length, deliveredBytes: data.length, expectedBytes: asset.size,
      contentSha256: asset.digest.slice(7), digestVerified: true });
    let value; try { value = JSON.parse(data); } catch { throw Error('execution witness: asset JSON invalid'); }
    assert(bytes(value).equals(data), 'asset is not canonical JSON'); return value;
  };
  const record = fetchAsset('source-candidate.json');
  assert(exact(record, ['schemaVersion', 'sourceCommit', 'sourceVersion', 'sourceContentHash', 'sourceIndexSha256', 'sourceProducer', 'sourceReleaseAttempt', 'generatorCommit', 'producer', 'candidateSets', 'recordSha256']), 'registry fields invalid');
  const { recordSha256, ...projection } = record;
  assert(HEX.test(recordSha256 || '') && sha256(bytes(projection)) === recordSha256 && record.schemaVersion === 2
    && record.sourceCommit === binding.sourceCommit && record.sourceVersion === binding.resourceVersion
    && record.generatorCommit === binding.generatorCommit && exact(record.candidateSets, ['free', 'pro']), 'registry identity mismatch');
  const witness = fetchAsset(`execution-${producer.runId}-${producer.runAttempt}.json`);
  assert(exact(witness, ['schemaVersion', 'sourceCommit', 'sourceDispatchId', 'registrySha256', 'producer', 'candidates'])
    && witness.schemaVersion === 1 && witness.sourceCommit === binding.sourceCommit && witness.sourceDispatchId === sourceDispatchId
    && witness.registrySha256 === recordSha256 && exact(witness.producer, ['runId', 'runAttempt', 'headSha'])
    && String(witness.producer.runId) === String(producer.runId) && witness.producer.runAttempt === producer.runAttempt
    && witness.producer.headSha === producer.headSha && exact(witness.candidates, ['free', 'pro']), 'execution identity mismatch');
  for (const tier of ['free', 'pro']) {
    const item = witness.candidates[tier], expected = binding[tier];
    assert(exact(item, ['packageSetSha256', 'candidateRootSha256', 'candidateRootBytes']) && expected
      && HEX.test(item.packageSetSha256 || '') && item.packageSetSha256 === record.candidateSets[tier]
      && item.packageSetSha256 === expected.packageSetSha256 && HEX.test(item.candidateRootSha256 || '')
      && item.candidateRootSha256 === expected.candidateRootSha256 && Number.isSafeInteger(item.candidateRootBytes)
      && item.candidateRootBytes > 0 && item.candidateRootBytes <= 1024 * 1024 && item.candidateRootBytes === expected.candidateRootBytes,
    `${tier} root mismatch`);
  }
  return { record, witness };
}
