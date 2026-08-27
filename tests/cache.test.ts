import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheArtifact, type CacheIo } from "../src/core/cache.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function realIo(dir: string, overrides: Partial<CacheIo> = {}): CacheIo {
  return {
    mkdirSync: (path) => mkdirSync(path, { recursive: true }),
    writeFileSync: (path, bytes) => writeFileSync(path, bytes),
    renameSync: (from, to) => require("node:fs").renameSync(from, to),
    existsSync,
    rmSync: (path, options) => rmSync(path, options),
    readFileSync: (path) => new Uint8Array(readFileSync(path)),
    readdirSync: (path) => readdirSync(path),
    ...overrides,
  };
}

describe("cacheArtifact atomic persistence (R1/R5)", () => {
  it("writes the target atomically and leaves no orphan staging file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-ok-"));
    try {
      const target = join(dir, "nested", "artifact.tgz");
      cacheArtifact(realIo(dir), target, Buffer.from("verified bytes"));
      expect(readFileSync(target, "utf8")).toBe("verified bytes");
      expect(readdirSync(join(dir, "nested")).some((name) => name.includes(".staging-"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the previous cache and cleans its own staging when rename fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-fail-"));
    try {
      const target = join(dir, "artifact.tgz");
      writeFileSync(target, "old good bytes");
      let failed = false;
      const io = realIo(dir, {
        renameSync: () => {
          failed = true;
          throw new Error("rename denied");
        },
      });
      expect(() => cacheArtifact(io, target, Buffer.from("new bytes"))).toThrow("rename denied");
      expect(failed).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("old good bytes");
      expect(readdirSync(dir).some((name) => name.includes(".staging-"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing cache entry with the renamed bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-overwrite-"));
    try {
      const target = join(dir, "artifact.tgz");
      writeFileSync(target, "stale");
      cacheArtifact(realIo(dir), target, Buffer.from("fresh"));
      expect(readFileSync(target, "utf8")).toBe("fresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotent fast path: skips the write when the target already matches expectedSha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-idempotent-"));
    try {
      const target = join(dir, "artifact.tgz");
      const bytes = Buffer.from("same bytes");
      cacheArtifact(realIo(dir), target, bytes, sha256(bytes));
      expect(readFileSync(target, "utf8")).toBe("same bytes");
      // Second writer with matching digest writes nothing but succeeds.
      const writes: string[] = [];
      const io = realIo(dir, {
        writeFileSync: (path, data) => {
          writes.push(path);
          writeFileSync(path, data);
        },
      });
      cacheArtifact(io, target, Buffer.from("same bytes"), sha256(bytes));
      expect(writes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs a corrupt existing cache whose bytes do not match expectedSha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-repair-"));
    try {
      const target = join(dir, "artifact.tgz");
      writeFileSync(target, "corrupt bytes");
      const bytes = Buffer.from("verified bytes");
      cacheArtifact(realIo(dir), target, bytes, sha256(bytes));
      expect(readFileSync(target, "utf8")).toBe("verified bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent writers never share a staging file and leave a correct final artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-concurrent-"));
    try {
      const target = join(dir, "artifact.tgz");
      const bytes = Buffer.from("the one true verified payload");
      const io = realIo(dir);
      await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => cacheArtifact(io, target, bytes, sha256(bytes)))));
      expect(readFileSync(target, "utf8")).toBe("the one true verified payload");
      const staging = readdirSync(dir).filter((name) => name.includes(".staging-"));
      expect(staging).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweeps a pre-existing crashed-writer staging orphan after a successful write", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-sweep-"));
    try {
      const target = join(dir, "artifact.tgz");
      const stale = join(dir, "artifact.tgz.staging-1234-deadbeef");
      writeFileSync(stale, "crashed writer bytes");
      cacheArtifact(realIo(dir), target, Buffer.from("fresh"), sha256(Buffer.from("fresh")));
      expect(readFileSync(target, "utf8")).toBe("fresh");
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
