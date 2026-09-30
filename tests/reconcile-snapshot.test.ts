import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeManagedReconcile } from "../src/project/install.js";
import { sha256Bytes } from "../src/project/install-metadata.js";

const fs = { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync, copyFileSync };

describe("reconcile checks all planned bytes again before replacing files", () => {
  for (const action of ["replace", "remove"] as const) {
    it(`preserves a concurrent binary edit during ${action}`, () => {
      const project = mkdtempSync(join(tmpdir(), "moe-snapshot-"));
      const old = Buffer.from([0, 255, 1]);
      const edited = Buffer.from([0, 254, 2]);
      try {
        writeFileSync(join(project, "image.png"), old);
        expect(() => executeManagedReconcile(project,
          action === "replace" ? { "image.png": Buffer.from([1, 2, 3]) } : { "next.ts": "next" },
          action === "remove" ? ["image.png"] : [], {
            ...fs,
            writeFileSync: ((path: string, data: string | Uint8Array) => {
              writeFileSync(path, data);
              if (path.includes(".reconcile-staging-")) writeFileSync(join(project, "image.png"), edited);
            }) as typeof writeFileSync,
          }, { expectedSha256: { "image.png": sha256Bytes(old), "next.ts": undefined } })).toThrow("file changed since planning");
        expect(readFileSync(join(project, "image.png"))).toEqual(edited);
        expect(existsSync(join(project, "next.ts"))).toBe(false);
      } finally { rmSync(project, { recursive: true, force: true }); }
    });
  }
});
