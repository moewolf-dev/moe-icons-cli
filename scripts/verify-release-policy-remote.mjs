#!/usr/bin/env node
/**
 * AUD-BLOCK-02: download the Free contract from the pinned public commit and
 * require byte-for-byte equality with the vendored copy. Fail closed on network
 * error, 404 or any hash/byte mismatch.
 *
 * Tests inject `rawBase`; the executable path always uses the fixed GitHub raw
 * origin and cannot be redirected by repository/environment variables.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_REPO = 'moewolf-dev/moe-icons';
const SOURCE_PATH = 'contracts/release-policy/free-style-groups.v1.json';
const EXPECTED = ['moe-colored', 'moe-lite-outline', 'moe-outline', 'moe-solid'].sort();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyRemotePolicy({
  root,
  fetchImpl = globalThis.fetch,
  rawBase,
  signal = AbortSignal.timeout(15_000),
} = {}) {
  const base = rawBase || 'https://raw.githubusercontent.com';
  const dir = path.join(root, 'vendor', 'moe-icons-release-policy');
  const bytes = fs.readFileSync(path.join(dir, 'free-style-groups.v1.json'));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'PIN.json'), 'utf8'));
  assert(/^[0-9a-f]{40}$/.test(pin.sourceCommit || ''), 'PIN sourceCommit must be a full 40-hex commit');
  assert(pin.sourceRepo === SOURCE_REPO, `PIN sourceRepo must be ${SOURCE_REPO}`);
  assert(pin.sourcePath === SOURCE_PATH, 'PIN sourcePath is wrong');
  assert(pin.schemaVersion === 1, 'PIN schemaVersion must be 1');
  assert(pin.sha256 === sha256, 'vendored release policy SHA-256 does not match PIN');

  const url = `${base}/${pin.sourceRepo}/${pin.sourceCommit}/${pin.sourcePath}`;
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal });
  } catch (error) {
    throw new Error(`remote release policy fetch failed: ${error.message}`);
  }
  if (!response || response.ok !== true) {
    throw new Error(`remote release policy fetch failed: HTTP ${response ? response.status : 'no response'}`);
  }
  const remote = Buffer.from(await response.arrayBuffer());
  const remoteSha = crypto.createHash('sha256').update(remote).digest('hex');
  assert(remoteSha === pin.sha256, `remote release policy SHA-256 ${remoteSha} != PIN ${pin.sha256}`);
  assert(remote.equals(bytes), 'vendored release policy bytes differ from the pinned remote bytes');
  const parsed = JSON.parse(remote.toString('utf8'));
  assert(parsed.schemaVersion === 1, 'remote release policy schemaVersion must be 1');
  const sorted = parsed.freeStyleGroups.slice().sort();
  assert(
    sorted.length === EXPECTED.length && sorted.every((group, index) => group === EXPECTED[index]),
    'remote Free set must exactly equal the frozen four groups',
  );
  return { sha256: remoteSha, sourceCommit: pin.sourceCommit, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  verifyRemotePolicy({ root })
    .then((result) => {
      process.stdout.write(`Release policy remote verification passed (${result.sourceCommit}, sha256=${result.sha256}).\n`);
    })
    .catch((error) => {
      process.stderr.write(`ERROR: ${error.message}\n`);
      process.exitCode = 1;
    });
}
