import { gzipSync, gunzipSync } from "node:zlib";

const BLOCK = 512;

function checksumHeader(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += header[i] ?? 0;
  return sum;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const text = `${value.toString(8).padStart(length - 1, "0")}\0`;
  buf.write(text.slice(0, length), offset, length, "utf8");
}

/** Build a gzipped POSIX tar from in-memory files (test fixtures and unpacking). */
export function createTarGz(files: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const parts: Buffer[] = [];
  const names = Object.keys(files).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    if (name.includes("..") || name.startsWith("/")) {
      throw new Error(`unsafe tar path: ${name}`);
    }
    const raw = files[name];
    const body = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw ?? []);
    const header = Buffer.alloc(BLOCK, 0);
    Buffer.from(name).copy(header, 0, 0, Math.min(name.length, 100));
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.byteLength);
    writeOctal(header, 136, 12, 0);
    header.write("        ", 148, 8, "utf8");
    header[156] = 0x30;
    header.write("ustar", 257, 5, "utf8");
    header[262] = 0;
    header.write("00", 263, 2, "utf8");
    const sum = checksumHeader(header);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    parts.push(header, body);
    const pad = (BLOCK - (body.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export type ExtractedTarFiles = {
  readonly files: Record<string, Uint8Array>;
  readonly errors: string[];
};

function readOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/, "").trim();
  if (!raw) return 0;
  return Number.parseInt(raw, 8);
}

/** Gunzip + unpack tar; reject absolute paths, `..`, and oversized archives. */
export function extractTarGz(
  bytes: Uint8Array,
  limits: { maxEntries: number; maxExpandedBytes: number },
): ExtractedTarFiles {
  const files: Record<string, Uint8Array> = {};
  const errors: string[] = [];
  let data: Buffer;
  try {
    data = gunzipSync(bytes);
  } catch {
    return { files, errors: ["invalid gzip"] };
  }

  let offset = 0;
  let entries = 0;
  let expanded = 0;
  while (offset + BLOCK <= data.byteLength) {
    const header = data.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").replace(/^\.\//, "");
    const size = readOctal(header, 124, 12);
    const type = header[156];
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const content = data.subarray(offset, offset + size);
    offset += padded;
    if (type !== 0 && type !== 0x30) continue;
    if (!name || name.endsWith("/")) continue;
    entries += 1;
    if (entries > limits.maxEntries) {
      errors.push(`too many entries (> ${limits.maxEntries})`);
      break;
    }
    if (name.startsWith("/") || name.split("/").includes("..")) {
      errors.push(`unsafe path "${name}"`);
      continue;
    }
    expanded += content.byteLength;
    if (expanded > limits.maxExpandedBytes) {
      errors.push("expanded size exceeds limit");
      break;
    }
    files[name] = new Uint8Array(content);
  }
  return { files, errors };
}

export function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}
