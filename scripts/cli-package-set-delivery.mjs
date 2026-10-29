import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const assert = (value, message) => { if (!value) throw new Error(message); };
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value, keys, label) => assert(record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} has unexpected or missing fields`);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalBytes = value => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Build the plugin joint-delivery event from the immutable CLI resource pin. */
export function buildCliPackageSetDelivery({ resource, receipt, run, publishRunId }) {
  exactKeys(resource, ['schemaVersion', 'resourceVersion', 'sourceCommit', 'generatorCommit', 'sourceDispatchId', 'producer', 'packageSets', 'packageSetResourceDigest', 'packageSetDescriptorSha256', 'catalogSha256', 'appliedAt'], 'CLI package-set resource pin');
  assert(resource.schemaVersion === 2 && VERSION.test(resource.resourceVersion || '') && COMMIT.test(resource.sourceCommit || '') && COMMIT.test(resource.generatorCommit || '') && SHA.test(resource.sourceDispatchId || ''), 'CLI package-set resource identity is invalid');
  assert(receipt && VERSION.test(receipt.version || '') && /^[a-f0-9]{40}$/.test(receipt.releaseCommit || '') && /^sha512-/.test(receipt.npmIntegrity || '') && String(receipt.runId) === String(publishRunId), 'CLI publisher receipt identity is invalid');
  assert(run && COMMIT.test(run.head_sha || '') && String(run.id) === String(publishRunId) && run.conclusion === 'success', 'CLI publish run identity is invalid');
  const binding = resource.packageSets;
  exactKeys(binding, ['schemaVersion', 'resourceVersion', 'sourceCommit', 'generatorCommit', 'free', 'pro'], 'package-set root binding');
  assert(binding.schemaVersion === 1 && binding.resourceVersion === resource.resourceVersion && binding.sourceCommit === resource.sourceCommit && binding.generatorCommit === resource.generatorCommit, 'package-set root binding differs from the resource pin');
  for (const tier of ['free', 'pro']) {
    const row = binding[tier];
    exactKeys(row, ['packageSetSha256', 'candidateRootSha256', 'candidateRootBytes'], `${tier} candidate binding`);
    assert(SHA.test(row.packageSetSha256 || '') && SHA.test(row.candidateRootSha256 || '') && Number.isSafeInteger(row.candidateRootBytes) && row.candidateRootBytes > 0 && row.candidateRootBytes <= 1024 ** 2, `${tier} candidate binding is invalid`);
  }
  assert(binding.free.packageSetSha256 !== binding.pro.packageSetSha256, 'Free and Pro package-set identities must differ');
  const producer = resource.producer;
  exactKeys(producer, ['repository', 'workflowPath', 'runId', 'runAttempt', 'headSha'], 'candidate producer');
  assert(producer.repository === 'moewolf-dev/moe-icons-code-library' && producer.workflowPath === '.github/workflows/small-pack-candidate.yml' && /^[1-9]\d*$/.test(String(producer.runId)) && Number.isSafeInteger(producer.runAttempt) && producer.runAttempt > 0 && COMMIT.test(producer.headSha || ''), 'candidate producer identity is invalid');
  const descriptorSha256 = sha256(canonicalBytes(binding));
  const resourceDigest = sha256(`moe-icons-package-set-resource-v1\n${resource.resourceVersion}\n${resource.sourceCommit}\n${resource.generatorCommit}\n${binding.free.packageSetSha256}\n${binding.pro.packageSetSha256}\n`);
  assert(resource.packageSetDescriptorSha256 === descriptorSha256 && resource.packageSetResourceDigest === resourceDigest, 'package-set resource digests mismatch');
  const eventId = `resource:${resource.resourceVersion}:cli:${receipt.version}`;
  return {
    eventId,
    delivery: {
      eventId,
      cliVersion: receipt.version,
      cliPublishRunId: String(publishRunId),
      cliPublishHead: run.head_sha,
      cliNpmIntegrity: receipt.npmIntegrity,
      resourceVersion: resource.resourceVersion,
      sourceCommit: resource.sourceCommit,
      generatorCommit: resource.generatorCommit,
      sourceDispatchId: resource.sourceDispatchId,
      packageSets: binding,
      producer,
      resourceDigest,
      descriptorSha256,
      cliReleaseCommit: receipt.releaseCommit,
    },
  };
}
