'use strict';
// N08-05: the CLI registry verification download must record real response
// bytes, retries and failure prefixes. A loopback HTTP server keeps it offline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/metered-curl.cjs');
const body = Buffer.from('exact registry tarball bytes');

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/pkg.tgz`;
  try { return await fn(url); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-metered-curl-')); }

test('a successful download is measured and digest verified', async () => {
  const dir = tempDir();
  try {
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    await withServer((request, response) => {
      assert.equal(request.url, '/pkg.tgz');
      response.writeHead(200, { 'content-length': body.length });
      response.end(body);
    }, async (url) => {
      const result = await runAsync(['--url', url, '--output', path.join(dir, 'pkg.tgz'),
        '--expected-sha256', digest, '--transport-report', path.join(dir, 'transport.json'),
        '--allow-http-loopback']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'pkg.tgz')), body);
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'transport.json'), 'utf8'));
      assert.equal(report.scope, 'cli-registry-verify');
      assert.equal(report.complete, true);
      assert.equal(report.totals.attempts, 1);
      assert.equal(report.totals.responseBytes, body.length);
      assert.equal(report.totals.verifiedDownloads, 1);
      assert.match(result.stdout, /\[small-pack-consumer-transport\]/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a transient 503 is retried and keeps the failed attempt unknown', async () => {
  const dir = tempDir();
  try {
    let hits = 0;
    await withServer((request, response) => {
      hits += 1;
      if (hits === 1) { response.writeHead(503, { 'content-length': 4 }); response.end('busy'); return; }
      response.writeHead(200, { 'content-length': body.length });
      response.end(body);
    }, async (url) => {
      const result = await runAsync(['--url', url, '--output', path.join(dir, 'pkg.tgz'),
        '--transport-report', path.join(dir, 'transport.json'), '--allow-http-loopback']);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'transport.json'), 'utf8'));
      assert.equal(report.totals.attempts, 2);
      assert.equal(report.totals.retries, 1);
      assert.equal(report.totals.failedAttempts, 1);
      assert.equal(report.totals.unknownResponses, 1);
      assert.equal(report.totals.responseBytes, body.length);
      assert.equal(report.complete, false);
      assert.ok(report.bypassRisk.includes('unknown-response-bytes'));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing object fails without leaving a file', async () => {
  const dir = tempDir();
  try {
    await withServer((request, response) => { response.writeHead(404); response.end('missing'); }, async (url) => {
      const result = await runAsync(['--url', url, '--output', path.join(dir, 'pkg.tgz'),
        '--transport-report', path.join(dir, 'transport.json'), '--allow-http-loopback']);
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(dir, 'pkg.tgz')), false);
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'transport.json'), 'utf8'));
      assert.equal(report.complete, false);
      assert.equal(report.totals.failedCalls, 1);
      assert.ok(report.bypassRisk.includes('failed-download-call'));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a digest mismatch is an integrity failure, not a success', async () => {
  const dir = tempDir();
  try {
    await withServer((request, response) => {
      response.writeHead(200, { 'content-length': body.length });
      response.end(body);
    }, async (url) => {
      const result = await runAsync(['--url', url, '--output', path.join(dir, 'pkg.tgz'),
        '--expected-sha256', 'b'.repeat(64), '--transport-report', path.join(dir, 'transport.json'),
        '--allow-http-loopback']);
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(dir, 'pkg.tgz')), false);
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'transport.json'), 'utf8'));
      assert.equal(report.complete, false);
      assert.equal(report.totals.failedCalls, 1);
      assert.equal(report.entries[0].errorClass, 'integrity');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('non-loopback http URLs are rejected before any download', () => {
  const result = require('node:child_process').spawnSync(process.execPath, [script,
    '--url', 'http://example.com/pkg.tgz', '--output', '/tmp/never'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be https/);
});
