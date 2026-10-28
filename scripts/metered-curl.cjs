#!/usr/bin/env node
'use strict';
// N08-05: metered `curl` for the CLI registry verification.
//
// The publish workflow re-downloads the immutable npm tarball and compares its
// contents. This wrapper keeps that download but records the real response
// bytes, the HTTP status and the delivered prefix of a failed attempt in the
// shared consumer transport report.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRecorder, summary, writeReport } = require('./small-pack-consumer-transport.cjs');

const MAX_BYTES = 128 * 1024 ** 2;

function fail(message) { throw new Error(`cli metered curl: ${message}`); }

function parseArgs(argv) {
  const out = { headers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === '--header') { out.headers.push(next); index += 1; continue; }
    if (item === '--allow-http-loopback') { out['allow-http-loopback'] = true; continue; }
    if (item.startsWith('--')) { out[item.slice(2)] = next; index += 1; }
  }
  return out;
}

function validateUrl(value, { allowHttpLoopback }) {
  let url;
  try { url = new URL(String(value)); } catch { fail('--url is not a valid URL'); }
  if (url.username || url.password) fail('--url must not contain credentials');
  if (url.protocol === 'https:') return url;
  if (allowHttpLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return url;
  fail('--url must be https (http is only allowed for loopback tests)');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runCurl({ url, output, headers, allowHttp }) {
  const args = ['--silent', '--show-error', '--fail', '--location',
    '--proto', allowHttp ? '=http,https' : '=https',
    '--proto-redir', allowHttp ? '=http,https' : '=https',
    '--max-filesize', String(MAX_BYTES),
    '--write-out', '\n%{size_download} %{http_code}',
    '--output', output];
  for (const header of headers) args.push('--header', header);
  args.push(url);
  const result = spawnSync('curl', args, { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
  const match = /\n(\d+) ([1-5][0-9]{2})\s*$/.exec(result.stdout || '');
  return {
    status: result.status,
    stderr: result.stderr,
    sizeDownload: match ? Number(match[1]) : null,
    httpStatus: match ? Number(match[2]) : null,
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
  };
}

function transient(result) {
  if (result.timedOut) return true;
  if (result.httpStatus !== null && result.httpStatus >= 500) return true;
  return /Could not resolve|Connection reset|timed out|TLS|operation too slow|Empty reply/i.test(result.stderr || '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = validateUrl(args.url, { allowHttpLoopback: args['allow-http-loopback'] === true });
  const output = args.output;
  const reportPath = args['transport-report'];
  const scope = args.scope || 'cli-registry-verify';
  const expectedSha256 = typeof args['expected-sha256'] === 'string' && args['expected-sha256'] !== ''
    ? args['expected-sha256'].toLowerCase() : null;
  if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256)) fail('--expected-sha256 must be 64 lowercase hex characters');
  if (typeof output !== 'string' || output === '') fail('--output is required');
  const recorder = createRecorder({ scope });
  const callId = `${url.origin}${url.pathname}#1`;
  let succeeded = false;
  try {
    for (let attempt = 1; ; attempt += 1) {
      fs.rmSync(output, { force: true });
      const startedAt = new Date().toISOString();
      const result = runCurl({ url: url.href, output, headers: args.headers, allowHttp: args['allow-http-loopback'] === true });
      if (result.status === 0 && result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300) {
        const size = fs.existsSync(output) ? fs.statSync(output).size : -1;
        const actualSha256 = size >= 0 ? sha256File(output) : null;
        const sizeOk = size >= 0 && (result.sizeDownload === null || result.sizeDownload === size);
        const digestOk = expectedSha256 === null || actualSha256 === expectedSha256;
        if (!sizeOk || !digestOk) {
          recorder.record({
            callId, route: `${url.origin}${url.pathname}`, attempt, status: 'failed', responseBytes: null,
            deliveredBytes: size >= 0 ? size : result.sizeDownload, expectedBytes: null,
            contentSha256: actualSha256, digestVerified: expectedSha256 === null ? null : false,
            errorClass: 'integrity', httpStatus: result.httpStatus, startedAt, finishedAt: new Date().toISOString(),
          });
          fail(digestOk ? 'downloaded byte count differs from curl size_download' : 'downloaded tarball digest differs from the expected digest');
        }
        recorder.record({
          callId, route: `${url.origin}${url.pathname}`, attempt, status: 'complete',
          responseBytes: size, deliveredBytes: size, expectedBytes: null,
          contentSha256: actualSha256, digestVerified: expectedSha256 === null ? null : true,
          errorClass: null, httpStatus: result.httpStatus, startedAt, finishedAt: new Date().toISOString(),
        });
        succeeded = true;
        return;
      }
      recorder.record({
        callId, route: `${url.origin}${url.pathname}`, attempt, status: 'failed', responseBytes: null,
        deliveredBytes: result.sizeDownload, expectedBytes: null, contentSha256: null, digestVerified: null,
        errorClass: result.timedOut ? 'timeout' : transient(result) ? 'transient' : 'http-status',
        httpStatus: result.httpStatus, startedAt, finishedAt: new Date().toISOString(),
      });
      const retryable = transient(result);
      if (attempt >= 3 || !retryable) {
        fail(`download failed (exit ${result.status}, HTTP ${result.httpStatus ?? 'unknown'}): ${(result.stderr || '').trim()}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, [1000, 3000][attempt - 1]);
    }
  } finally {
    const report = recorder.close();
    if (reportPath) writeReport(reportPath, report);
    process.stdout.write(`[small-pack-consumer-transport] ${JSON.stringify(summary(report, { reportPath: reportPath || null }))}\n`);
    if (!succeeded) fs.rmSync(output, { force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message.startsWith('cli metered curl: ') ? error.message : `cli metered curl: ${error.message}`}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };
