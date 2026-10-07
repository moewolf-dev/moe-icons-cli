import { gzipSync, gunzipSync, createGunzip } from "node:zlib";
import { Readable } from "node:stream";

const BLOCK = 512;

/**
 * Combined release archives contain all four target trees. The current Pro
 * contract is roughly 60k regular files (9 groups × 554 icons), so the former
 * 20k cap rejected valid official packages. The six-spec bitmap matrix expands
 * to ~205 MiB (tar stream ~257 MiB), so the expanded ceiling covers that with
 * headroom while staying finite for zip-bomb protection. `extractTarGz` enforces
 * the same bound during gunzip via `maxOutputLength`, before the tar stream is
 * materialised.
 */
export const ICON_ARCHIVE_MAX_ENTRIES = 100_000;
export const ICON_ARCHIVE_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

/** True when a zlib gunzip failure means the bounded output was exceeded. */
function isOutputLimitError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength|output length/i.test(message);
}

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
  const raw = buf.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error("invalid tar numeric field");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid tar size");
  return value;
}

/** One incremental parser used by both fixture and production extraction. */
class TarReader {
  readonly files: Record<string, Uint8Array> = {};
  readonly errors: string[] = [];
  private header = Buffer.alloc(BLOCK);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private padding = 0;
  private name = "";
  private longName: string | undefined;
  private type = 0;
  private total = 0;
  private entries = 0;
  private zeroBlocks = 0;
  private failed = false;
  constructor(private readonly limits: { maxEntries: number; maxExpandedBytes: number }) {}
  private fail(message: string): void { this.errors.push(message); this.failed = true; }
  feed(bytes: Uint8Array): void {
    if (this.failed) return;
    this.total += bytes.length;
    if (this.total > this.limits.maxExpandedBytes) return this.fail("expanded size exceeds limit");
    let offset = 0;
    while (offset < bytes.length && !this.failed) {
      if (this.body) {
        const count = Math.min(this.body.length - this.bodyBytes, bytes.length - offset);
        this.body.set(bytes.subarray(offset, offset + count), this.bodyBytes);
        offset += count; this.bodyBytes += count;
        if (this.bodyBytes !== this.body.length) continue;
        this.finishBody();
      } else if (this.padding) {
        const count = Math.min(this.padding, bytes.length - offset);
        offset += count; this.padding -= count;
      } else {
        const count = Math.min(BLOCK - this.headerBytes, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count; offset += count;
        if (this.headerBytes === BLOCK) { this.headerBytes = 0; this.beginBody(); }
      }
    }
  }
  private beginBody(): void {
    const header = this.header;
    if (header.every(byte => byte === 0)) { this.zeroBlocks++; return; }
    if (this.zeroBlocks) return this.fail("tar data after end marker");
    try {
      const expected = readOctal(header, 148, 8);
      const copy = Buffer.from(header); copy.fill(0x20, 148, 156);
      if (checksumHeader(copy) !== expected) return this.fail("invalid tar header checksum");
      const size = readOctal(header, 124, 12);
      if (size > this.limits.maxExpandedBytes) return this.fail("expanded size exceeds limit");
      this.entries++;
      if (this.entries > this.limits.maxEntries) return this.fail(`too many entries (> ${this.limits.maxEntries})`);
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const prefix = header.subarray(257, 263).toString("ascii") === "ustar\0"
        ? header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "") : "";
      this.name = this.longName ?? (prefix ? `${prefix}/${name}` : name);
      this.longName = undefined;
      this.name = this.name.replace(/^\.\//, "");
      this.type = header[156] ?? 0;
      this.padding = (BLOCK - size % BLOCK) % BLOCK;
      this.bodyBytes = 0;
      this.body = Buffer.alloc(size);
      if (size === 0) this.finishBody();
    } catch (error) { this.fail(error instanceof Error ? error.message : "invalid tar header"); }
  }
  private finishBody(): void {
    const body = this.body!; this.body = undefined;
    if (this.type === 0x4c) { // GNU long names, emitted by the production packer.
      this.longName = body.toString("utf8").replace(/\0.*$/, ""); return;
    }
    if (this.type === 0x31 || this.type === 0x32) { this.errors.push(`link entries are not allowed: ${this.name}`); return; }
    if (this.type === 0x35) return;
    if (this.type !== 0 && this.type !== 0x30) return this.fail("unsupported tar entry type");
    if (!this.name || this.name.startsWith("/") || this.name.split("/").includes("..")) {
      this.errors.push(`unsafe path "${this.name}"`); return;
    }
    if (this.name in this.files) { this.errors.push(`duplicate entry "${this.name}"`); return; }
    this.files[this.name] = body;
  }
  result(): ExtractedTarFiles {
    if (!this.failed && (this.body || this.padding || this.headerBytes || this.zeroBlocks < 2 || this.longName)) this.errors.push("truncated tar archive");
    return { files: this.files, errors: this.errors };
  }
}

export function extractTarGz(bytes: Uint8Array, limits: { maxEntries: number; maxExpandedBytes: number }): ExtractedTarFiles {
  const reader = new TarReader(limits);
  try { reader.feed(gunzipSync(bytes, { maxOutputLength: limits.maxExpandedBytes })); }
  catch (error) { return { files: {}, errors: [isOutputLimitError(error) ? "expanded size exceeds limit" : "invalid gzip"] }; }
  return reader.result();
}

/** Production path: yield between chunks; never materialise the complete tar. */
export async function extractTarGzAsync(bytes: Uint8Array, limits: { maxEntries: number; maxExpandedBytes: number }, signal?: AbortSignal): Promise<ExtractedTarFiles> {
  const reader = new TarReader(limits);
  const stream = Readable.from([bytes]).pipe(createGunzip());
  const abort = () => stream.destroy(new Error("archive extraction cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const chunk of stream) {
      reader.feed(chunk as Buffer);
      if (reader.errors.length) { stream.destroy(); break; }
    }
    return reader.result();
  } catch (error) { return { files: {}, errors: [signal?.aborted ? "archive extraction cancelled" : "invalid gzip"] }; }
  finally { signal?.removeEventListener("abort", abort); stream.destroy(); }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}
