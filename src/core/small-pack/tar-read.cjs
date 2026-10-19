'use strict';

/**
 * PATCH-24-C: strict structured tar reader.
 *
 * Validates header checksum, strict octal/base-256 size, payload truncation and
 * padding, the end-of-archive marker with no non-zero trailing bytes, PAX record
 * lengths/scopes and GNU long names. Returns entries with the raw path plus the
 * file bytes so callers never have to hand the same archive to a second parser
 * (e.g. system tar) that might interpret it differently.
 */

const BLOCK = 512;
const DEFAULT_MAX_ENTRIES = 200000;
// CI FLOW RULE: parse one bounded resource package per invocation, not a
// concatenated tier archive.
const DEFAULT_MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end >= 0 ? slice.subarray(0, end) : slice).toString('utf8');
}

function roundUp(size) {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function isZeroBlock(buffer, offset) {
  for (let index = offset; index < offset + BLOCK; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function parseOctal(field, label) {
  const text = field.toString('latin1').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar ${label} is not valid octal: ${JSON.stringify(text)}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tar ${label} is out of range`);
  return value;
}

/** GNU base-256 encoding when the high bit of the first byte is set. */
function parseSize(field) {
  if (field[0] & 0x80) {
    let value = 0n;
    for (const byte of field) value = (value << 8n) | BigInt(byte & 0x7f);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('tar size overflows safe integer');
    return Number(value);
  }
  return parseOctal(field, 'size');
}

function parseChecksum(field) {
  const text = field.toString('latin1').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar checksum is not valid octal: ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
}

function computeChecksums(header) {
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index];
    unsigned += byte;
    signed += byte < 0x80 ? byte : byte - 0x100;
  }
  return { unsigned, signed };
}

function verifyChecksum(header, offset) {
  const stored = parseChecksum(header.subarray(148, 156));
  const { unsigned, signed } = computeChecksums(header);
  if (stored !== unsigned && stored !== signed) {
    throw new Error(`tar checksum mismatch at block ${offset / BLOCK}: stored ${stored}, computed ${unsigned}`);
  }
}

function parsePax(data) {
  const record = {};
  let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space < 0) throw new Error('malformed pax record: missing length separator');
    const lengthText = data.subarray(cursor, space).toString('latin1');
    if (!/^\d+$/.test(lengthText)) throw new Error('malformed pax record: non-numeric length');
    const length = Number.parseInt(lengthText, 10);
    if (length <= 0 || cursor + length > data.length) throw new Error('malformed pax record: length overruns payload');
    const raw = data.subarray(space + 1, cursor + length);
    if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) throw new Error('malformed pax record: missing newline');
    // Lengths are UTF-8 byte counts; decode only the value bytes.
    const body = raw.subarray(0, raw.length - 1).toString('utf8');
    const equals = body.indexOf('=');
    if (equals < 0) throw new Error('malformed pax record: missing "="');
    record[body.slice(0, equals)] = body.slice(equals + 1);
    cursor += length;
  }
  if (cursor !== data.length) throw new Error('malformed pax record: trailing bytes');
  return record;
}

/**
 * @param {Buffer} buffer full tar archive bytes
 * @param {{maxEntries?:number,maxExpandedBytes?:number}} [options]
 */
function readTarEntries(buffer, options = {}) {
  const maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxExpandedBytes = options.maxExpandedBytes || DEFAULT_MAX_EXPANDED_BYTES;
  const entries = [];
  let offset = 0;
  let pendingLongName = null;
  let pendingPax = null;
  let globalPax = {};
  let expandedBytes = 0;
  let metadataCount = 0;
  let terminated = false;

  while (offset < buffer.length) {
    if (offset + BLOCK > buffer.length) throw new Error(`tar truncated header at offset ${offset}`);
    if (isZeroBlock(buffer, offset)) {
      // POSIX requires two consecutive 512-byte zero blocks; anything after the
      // two blocks must be zero record padding.
      const second = offset + BLOCK;
      if (second + BLOCK > buffer.length || !isZeroBlock(buffer, second)) {
        throw new Error('tar is missing the two-block end-of-archive marker');
      }
      for (let index = second; index < buffer.length; index += 1) {
        if (buffer[index] !== 0) throw new Error('tar has trailing data after the end-of-archive marker');
      }
      terminated = true;
      break;
    }
    const header = buffer.subarray(offset, offset + BLOCK);
    verifyChecksum(header, offset);

    const name = readString(header, 0, 100);
    const type = String.fromCharCode(header[156]);
    const linkname = readString(header, 157, 100);
    const prefix = readString(header, 345, 155);
    const size = parseSize(header.subarray(124, 136));
    const dataStart = offset + BLOCK;
    const paddedSize = roundUp(size);
    if (dataStart + paddedSize > buffer.length) {
      throw new Error(`tar payload truncated for ${name || '<unnamed>'} (size ${size})`);
    }
    if (size < 0) throw new Error('tar negative size');
    expandedBytes += size;
    if (expandedBytes > maxExpandedBytes) throw new Error('tar expanded size exceeds limit');
    const data = buffer.subarray(dataStart, dataStart + size);
    // Padding bytes must be zero.
    for (let index = dataStart + size; index < dataStart + paddedSize; index += 1) {
      if (buffer[index] !== 0) throw new Error(`tar non-zero padding for ${name || '<unnamed>'}`);
    }

    let filePath = prefix ? `${prefix}/${name}` : name;
    if (pendingLongName !== null) filePath = pendingLongName;
    const pax = pendingPax ? { ...globalPax, ...pendingPax } : globalPax;
    if (pax.path) filePath = pax.path;
    const entryLink = pax.linkpath || linkname;

    const isMetadata = type === 'L' || type === 'x' || type === 'g';
    if (isMetadata) {
      // Metadata headers count toward the entry budget and are size-capped.
      metadataCount += 1;
      if (entries.length + metadataCount > maxEntries) throw new Error('tar entry count exceeds limit');
      if (size > MAX_METADATA_BYTES) throw new Error('tar metadata entry exceeds size limit');
    }
    if (type === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      pendingPax = null;
      offset = dataStart + paddedSize;
      continue;
    }
    if (type === 'x' || type === 'g') {
      const parsed = parsePax(data);
      if (type === 'x') pendingPax = parsed;
      else globalPax = parsed;
      offset = dataStart + paddedSize;
      continue;
    }
    pendingLongName = null;
    pendingPax = null;

    if (entries.length >= maxEntries) throw new Error('tar entry count exceeds limit');

    let kind;
    if (type === '5') kind = 'dir';
    else if (type === '0' || type === '\0' || type === '\u0000') kind = 'file';
    else if (type === '2') kind = 'symlink';
    else if (type === '1') kind = 'hardlink';
    else if (type === '6') kind = 'fifo';
    else kind = `other:${type}`;

    if (!isMetadata && (!filePath || filePath.length === 0)) throw new Error('tar entry has an empty path');

    entries.push({
      path: kind === 'dir' ? filePath.replace(/\/$/, '') : filePath,
      type: kind,
      linkname: entryLink || null,
      size,
      data: kind === 'file' ? data : null,
    });
    offset = dataStart + paddedSize;
  }

  if (!terminated) throw new Error('tar is missing the end-of-archive marker');
  return entries;
}

module.exports = {
  BLOCK,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXPANDED_BYTES,
  readTarEntries,
  parsePax,
  parseOctal,
};
