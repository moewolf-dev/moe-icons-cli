import { canonicalBytes, type CandidateRoot } from './small-pack/candidate-set.cjs';

export interface FreeCandidateVersionPointer {
  readonly schemaVersion: 1;
  readonly tier: 'free';
  readonly fullVersion: string;
  readonly sourceCommit: string;
  readonly generatorCommit: string;
  readonly packageSetSha256: string;
  readonly candidateRootSha256: string;
  readonly candidateRootBytes: number;
}

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta)(?:\.(?:0|[1-9]\d*))?)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_POINTER_BYTES = 16 * 1024;

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Free candidate version pointer: ${message}`);
}

export function parseFreeCandidateVersionPointer(input: Uint8Array, expectedVersion: string): FreeCandidateVersionPointer {
  check(VERSION.test(expectedVersion), 'requested version is invalid');
  const bytes = Buffer.from(input);
  check(bytes.length > 0 && bytes.length <= MAX_POINTER_BYTES, 'pointer exceeds 16 KiB');
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Free candidate version pointer: invalid JSON'); }
  check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'pointer object required');
  const value = raw as Record<string, unknown>;
  const fields = ['schemaVersion', 'tier', 'fullVersion', 'sourceCommit', 'generatorCommit', 'packageSetSha256', 'candidateRootSha256', 'candidateRootBytes'];
  check(Object.keys(value).sort().join(',') === [...fields].sort().join(','), 'unexpected pointer fields');
  check(bytes.equals(canonicalBytes(value)), 'pointer must use canonical JSON');
  check(value.schemaVersion === 1 && value.tier === 'free' && value.fullVersion === expectedVersion, 'pointer differs from exact Free version');
  check(typeof value.sourceCommit === 'string' && COMMIT.test(value.sourceCommit), 'Source commit is invalid');
  check(typeof value.generatorCommit === 'string' && COMMIT.test(value.generatorCommit), 'generator commit is invalid');
  check(typeof value.packageSetSha256 === 'string' && SHA256.test(value.packageSetSha256), 'package-set digest is invalid');
  check(typeof value.candidateRootSha256 === 'string' && SHA256.test(value.candidateRootSha256), 'candidate root digest is invalid');
  check(Number.isSafeInteger(value.candidateRootBytes) && Number(value.candidateRootBytes) > 0 && Number(value.candidateRootBytes) <= 1024 ** 2, 'candidate root size is invalid');
  return value as unknown as FreeCandidateVersionPointer;
}

export function pointerMatchesCandidateRoot(pointer: FreeCandidateVersionPointer, root: CandidateRoot): boolean {
  return pointer.tier === root.tier && pointer.fullVersion === root.fullVersion && pointer.sourceCommit === root.sourceCommit
    && pointer.generatorCommit === root.generatorCommit && pointer.packageSetSha256 === root.packageSetSha256;
}
