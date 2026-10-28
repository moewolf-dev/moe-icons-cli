'use strict';
// N08-05 consumer transport metering.
//
// Consumers download exact candidate bytes with `gh`/`curl`; this recorder
// counts what the consumer actually received instead of trusting the declared
// artifact size. It is deliberately narrower than the Generator checkout meter:
// only download attempts are recorded, and API lookups stay unmeasured.
//
// Rules:
// - unknown is not zero: a failed attempt has no measured response total, so
//   its `responseBytes` stays null and only the delivered prefix is recorded;
// - a retried call is complete only when its highest attempt succeeded with a
//   verified digest;
// - expected control-flow failures (a missing tag lookup) may be marked, but
//   they are still visible in the totals.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const KIND = 'small-pack-consumer-transport';
const SCOPES = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function fail(message) { throw new Error(`small-pack consumer transport: ${message}`); }

function digestString(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function createRecorder({ scope, now = () => new Date().toISOString() } = {}) {
  if (typeof scope !== 'string' || !SCOPES.test(scope)) fail('scope must be 1..64 characters of [A-Za-z0-9._:-]');
  const entries = [];
  const risks = new Set();
  const startedAt = now();
  let closed = false;

  function record(entry) {
    if (closed) fail('recorder is already closed');
    if (!entry || typeof entry !== 'object') fail('transport entry must be an object');
    const { callId, route, attempt, status } = entry;
    if (typeof callId !== 'string' || callId === '') fail('callId is required');
    if (typeof route !== 'string' || route === '') fail('route is required');
    if (!Number.isInteger(attempt) || attempt < 1) fail('attempt must be a positive integer');
    if (status !== 'complete' && status !== 'failed') fail('status must be complete or failed');
    for (const key of ['responseBytes', 'deliveredBytes', 'expectedBytes']) {
      const value = entry[key];
      if (value === undefined || value === null) continue;
      if (!Number.isSafeInteger(value) || value < 0) fail(`${key} must be a non-negative safe integer or null`);
    }
    const responseBytes = entry.responseBytes === undefined ? null : entry.responseBytes;
    const deliveredBytes = entry.deliveredBytes === undefined ? null : entry.deliveredBytes;
    if (status === 'complete' && responseBytes === null) fail('a complete attempt requires responseBytes');
    if (status === 'failed' && responseBytes !== null) fail('a failed attempt must leave responseBytes unknown');
    if (deliveredBytes !== null && responseBytes !== null && deliveredBytes > responseBytes) fail('deliveredBytes exceeds responseBytes');
    const contentSha256 = entry.contentSha256 === undefined ? null : entry.contentSha256;
    if (contentSha256 !== null && !/^[a-f0-9]{64}$/.test(contentSha256)) fail('contentSha256 must be 64 lowercase hex characters or null');
    const digestVerified = entry.digestVerified === undefined ? null : entry.digestVerified;
    if (digestVerified !== null && typeof digestVerified !== 'boolean') fail('digestVerified must be true, false or null');
    // A complete attempt may skip digest verification only when the route has no
    // declared digest (digestVerified=null); a mismatch is always a failure.
    if (status === 'complete' && digestVerified === false) fail('a verified-false digest cannot be a complete attempt');
    if (status === 'failed' && digestVerified === true) fail('a failed attempt cannot claim a verified digest');
    entries.push({
      callId,
      route,
      attempt,
      status,
      responseBytes,
      deliveredBytes,
      expectedBytes: entry.expectedBytes === undefined ? null : entry.expectedBytes,
      contentSha256,
      digestVerified,
      expectedFailure: entry.expectedFailure === true,
      errorClass: entry.errorClass ? String(entry.errorClass).slice(0, 64) : null,
      httpStatus: Number.isInteger(entry.httpStatus) ? entry.httpStatus : null,
      startedAt: entry.startedAt || null,
      finishedAt: entry.finishedAt || null,
    });
  }

  function risk(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(code)) fail(`invalid bypass risk ${code}`);
    risks.add(code);
  }

  function report() {
    const byCall = new Map();
    for (const entry of entries) {
      if (!byCall.has(entry.callId)) byCall.set(entry.callId, []);
      byCall.get(entry.callId).push(entry);
    }
    let retries = 0;
    let failedCalls = 0;
    let retriedCalls = 0;
    for (const attempts of byCall.values()) {
      attempts.sort((left, right) => left.attempt - right.attempt);
      const highest = attempts[attempts.length - 1].attempt;
      retries += highest - 1;
      if (highest > 1) retriedCalls += 1;
      const last = attempts[attempts.length - 1];
      if (last.status !== 'complete' && last.expectedFailure !== true) failedCalls += 1;
    }
    const failed = entries.filter((entry) => entry.status === 'failed');
    const unknownResponses = failed.filter((entry) => entry.expectedFailure !== true).length;
    const measured = entries.filter((entry) => entry.responseBytes !== null);
    const totals = {
      calls: byCall.size,
      attempts: entries.length,
      retries,
      retriedCalls,
      failedAttempts: failed.length,
      expectedFailedAttempts: failed.filter((entry) => entry.expectedFailure === true).length,
      failedCalls,
      completeAttempts: entries.filter((entry) => entry.status === 'complete').length,
      verifiedDownloads: entries.filter((entry) => entry.status === 'complete' && entry.digestVerified === true).length,
      unmatchedDigests: entries.filter((entry) => entry.status === 'complete' && entry.digestVerified === null).length,
      responseBytes: measured.reduce((sum, entry) => sum + entry.responseBytes, 0),
      deliveredBytesOnFailure: failed.reduce((sum, entry) => sum + (entry.deliveredBytes || 0), 0),
      expectedBytes: entries.filter((entry) => entry.expectedBytes !== null).reduce((sum, entry) => sum + entry.expectedBytes, 0),
      unknownResponses,
    };
    if (entries.length === 0) risks.add('no-measured-downloads');
    if (unknownResponses > 0) risks.add('unknown-response-bytes');
    if (failedCalls > 0) risks.add('failed-download-call');
    const finalComplete = entries.length > 0 && failedCalls === 0 && unknownResponses === 0 && risks.size === 0;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      kind: KIND,
      scope,
      startedAt,
      finishedAt: now(),
      complete: finalComplete,
      bypassRisk: [...risks].sort(),
      totals,
      entries,
    };
    payload.reportSha256 = digestString(payload);
    return payload;
  }

  function close() {
    closed = true;
    return report();
  }

  return { scope, record, risk, report, close };
}

function summary(report, { reportPath = null } = {}) {
  return {
    scope: report?.scope ?? null,
    complete: report?.complete === true,
    bypassRisk: report?.bypassRisk || [],
    totals: report?.totals || null,
    reportPath,
    reportSha256: report?.reportSha256 || null,
  };
}

module.exports = { KIND, SCHEMA_VERSION, createRecorder, digestString, summary, writeReport };
