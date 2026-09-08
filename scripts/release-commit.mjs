#!/usr/bin/env node
/**
 * E2E-R-P0-3: recoverable CLI release-commit helpers.
 *
 * The release commit must only be pushed AFTER the frozen version has been
 * built/tested/packed. A rerun finds the same commit by (bot marker, parent
 * source commit, payloadHash, only package*.json) instead of bumping again.
 *
 * Usage:
 *   node scripts/release-commit.mjs find --payload-hash <hex> [--source-commit <sha>]
 *   node scripts/release-commit.mjs message --version <X.Y.Z> --source-commit <sha>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = /^chore\(release\): cli v(\d+\.\d+\.\d+) \[source ([0-9a-f]{7,40})\]$/;
const ALLOWED = ['package.json', 'package-lock.json'];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Files touched by a commit. */
function filesOf(sha) {
  return git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/** payloadHash embedded in the package.json at a commit. */
function payloadHashOf(sha) {
  try {
    const raw = execFileSync('git', ['show', `${sha}:package.json`], { cwd: ROOT, encoding: 'utf8' });
    // The payload hash is recorded in a trailing comment field if present.
    const marker = /"payloadHash"\s*:\s*"([a-f0-9]{64})"/.exec(raw);
    return marker ? marker[1] : null;
  } catch {
    return null;
  }
}

function findReleaseCommit({ payloadHash, sourceCommit }) {
  const log = git(['log', 'origin/main', '-n', '50', '--format=%H']).split('\n').filter(Boolean);
  const matches = [];
  for (const sha of log) {
    const message = git(['log', '-1', '--format=%s', sha]);
    const marker = MARKER.exec(message);
    if (!marker) continue;
    if (sourceCommit && !sourceCommit.startsWith(marker[2])) continue;
    const files = filesOf(sha);
    if (files.length !== ALLOWED.length || !files.every((file, i) => file === ALLOWED[i])) continue;
    if (payloadHash && payloadHashOf(sha) !== payloadHash) continue;
    matches.push({ sha, version: marker[1], tag: `v${marker[1]}` });
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous release commit: ${matches.map((m) => m.sha).join(', ')}`);
  }
  return matches[0] ?? null;
}

/**
 * Anti-recursion guard for the `decide` job: a bot commit must carry the frozen
 * marker, touch only package*.json, have the expected parent, and match the
 * payload hash. A forged human commit with the same message is NOT skipped.
 */
function isBotReleaseCommit({ sha, actor, parentSha, payloadHash }) {
  const message = git(['log', '-1', '--format=%s', sha]);
  const marker = MARKER.exec(message);
  if (!marker) return { skip: false, reason: 'not a release marker' };
  if (!/-bot\]?$/.test(actor) && actor !== 'github-actions[bot]' && actor !== 'github-actions') {
    return { skip: false, reason: `unexpected actor ${actor}` };
  }
  const files = filesOf(sha);
  if (files.length !== ALLOWED.length || !files.every((file, i) => file === ALLOWED[i])) {
    return { skip: false, reason: 'release commit touches unexpected files' };
  }
  const parent = git(['rev-parse', `${sha}^`]);
  if (parentSha && parent !== parentSha) return { skip: false, reason: 'unexpected parent commit' };
  const recorded = payloadHashOf(sha);
  if (payloadHash && recorded !== payloadHash) return { skip: false, reason: 'payload hash mismatch' };
  return { skip: true, version: marker[1], tag: `v${marker[1]}` };
}

function main() {
  const command = process.argv[2];
  if (command === 'find') {
    process.stdout.write(
      `${JSON.stringify(findReleaseCommit({ payloadHash: arg('--payload-hash'), sourceCommit: arg('--source-commit') }))}\n`,
    );
    return;
  }
  if (command === 'guard') {
    process.stdout.write(
      `${JSON.stringify(
        isBotReleaseCommit({
          sha: arg('--sha') || git(['rev-parse', 'HEAD']),
          actor: arg('--actor') || '',
          parentSha: arg('--parent'),
          payloadHash: arg('--payload-hash'),
        }),
      )}\n`,
    );
    return;
  }
  if (command === 'message') {
    const version = arg('--version');
    const source = (arg('--source-commit') || '').slice(0, 7);
    process.stdout.write(`chore(release): cli v${version} [source ${source}]\n`);
    return;
  }
  throw new Error('usage: release-commit.mjs <find|guard|message>');
}

export { findReleaseCommit, isBotReleaseCommit, MARKER, ALLOWED };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
