import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { extractTarGz } from "../src/project/tar-gz.js";
import { createTarGz } from "../src/project/tar-gz.js";

const BLOCK = 512;

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += header[i] ?? 0;
  return sum;
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const text = `${value.toString(8).padStart(length - 1, "0")}\0`;
  buf.write(text.slice(0, length), offset, length, "utf8");
}

/** Build a single tar entry (header + body padded to a 512 block) of the given typeflag. */
function rawTarEntry(name: string, typeflag: number, body = ""): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  Buffer.from(name).copy(header, 0, 0, Math.min(name.length, 100));
  writeOctal(header, 124, 12, Buffer.byteLength(body));
  header[156] = typeflag;
  header.write("ustar", 257, 5, "utf8");
  const sum = checksum(header);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  const bodyBuf = Buffer.from(body);
  const block = Buffer.alloc(Math.ceil(bodyBuf.byteLength / BLOCK) * BLOCK, 0);
  bodyBuf.copy(block, 0);
  return Buffer.concat([header, block]);
}

/** Build a gzip tar containing a single entry of the given typeflag. */
function rawTar(name: string, typeflag: number, body = ""): Uint8Array {
  return gzipSync(Buffer.concat([rawTarEntry(name, typeflag, body), Buffer.alloc(2 * BLOCK, 0)]));
}

describe("tar-gz extraction hardening (R3/R6)", () => {
  it("rejects symlink entries instead of silently skipping them", () => {
    const result = extractTarGz(rawTar("evil-link", 0x32), { maxEntries: 100, maxExpandedBytes: 1024 });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/link/);
    expect(result.files["evil-link"]).toBeUndefined();
  });

  it("rejects hard-link entries explicitly", () => {
    const result = extractTarGz(rawTar("hard-link", 0x31), { maxEntries: 100, maxExpandedBytes: 1024 });
    expect(result.errors.some((error) => /link/.test(error))).toBe(true);
    expect(result.files["hard-link"]).toBeUndefined();
  });

  it("rejects duplicate regular-file names", () => {
    const dup = gzipSync(
      Buffer.concat([
        rawTarEntry("same.txt", 0x30, "first"),
        rawTarEntry("same.txt", 0x30, "second"),
        Buffer.alloc(2 * BLOCK, 0),
      ]),
    );
    const result = extractTarGz(dup, { maxEntries: 100, maxExpandedBytes: 1024 });
    expect(result.errors.some((error) => error.includes("duplicate entry"))).toBe(true);
    expect(Buffer.from(result.files["same.txt"] ?? []).toString("utf8")).toBe("first");
  });

  it("rejects absolute paths", () => {
    const result = extractTarGz(rawTar("/etc/passwd", 0x30, "x"), { maxEntries: 100, maxExpandedBytes: 1024 });
    expect(result.errors.some((error) => error.includes("unsafe path"))).toBe(true);
  });

  it("rejects parent-directory traversal", () => {
    const result = extractTarGz(rawTar("../escape", 0x30, "x"), { maxEntries: 100, maxExpandedBytes: 1024 });
    expect(result.errors.some((error) => error.includes("unsafe path"))).toBe(true);
  });

  it("treats a backslash name as a literal filename (POSIX separator assumption)", () => {
    const result = extractTarGz(rawTar("..\\escape", 0x30, "x"), { maxEntries: 100, maxExpandedBytes: 1024 });
    expect(result.errors).toEqual([]);
    expect(result.files["..\\escape"]).toBeDefined();
  });

  it("enforces the expanded-size cap", () => {
    const result = extractTarGz(createTarGz({ "big.bin": "x".repeat(2048) }), {
      maxEntries: 100,
      maxExpandedBytes: 512,
    });
    expect(result.errors.some((error) => error.includes("expanded size"))).toBe(true);
  });

  it("enforces the entry cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) files[`f${i}.txt`] = "x";
    const result = extractTarGz(createTarGz(files), { maxEntries: 10, maxExpandedBytes: 1_000_000 });
    expect(result.errors.some((error) => error.includes("too many entries"))).toBe(true);
  });
});
