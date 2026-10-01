import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstallPlan, executeInstallPlan } from "../src/project/install.js";
import { serializeInstallMetadata, sha256Bytes, type InstallMetadata } from "../src/project/install-metadata.js";

const fs = { existsSync, mkdirSync, renameSync, rmSync, writeFileSync };

describe("install commit and concurrent file safety", () => {
  let project: string;
  beforeEach(() => { project = mkdtempSync(join(tmpdir(), "moe-install-transaction-")); });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  it("keeps the committed files if backup cleanup partially fails", () => {
    mkdirSync(join(project, ".moeicons"));
    writeFileSync(join(project, "a.ts"), "old a");
    writeFileSync(join(project, "b.ts"), "old b");
    const metadata: InstallMetadata = {
      schemaVersion: 1, artifactVersion: "0.0.1", tier: "free", target: "react",
      descriptorSha256: "a".repeat(64), artifactSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), installedAt: "2026-09-29T00:00:00.000Z",
      managedFiles: { "a.ts": sha256Bytes("old a"), "b.ts": sha256Bytes("old b") },
    };
    writeFileSync(join(project, ".moeicons", "install-metadata.json"), serializeInstallMetadata(metadata));
    const next = serializeInstallMetadata({ ...metadata, managedFiles: { "a.ts": sha256Bytes("new a"), "b.ts": sha256Bytes("new b") } });
    const plan = createInstallPlan(project, { "a.ts": "new a", "b.ts": "new b", ".moeicons/install-metadata.json": next });
    expect(() => executeInstallPlan(plan, {
      ...fs,
      rmSync: (path, options) => {
        if (String(path).includes(".reconcile-backup-")) {
          rmSync(join(String(path), "a.ts"), { force: true });
          throw new Error("simulated partial backup cleanup");
        }
        return rmSync(path, options);
      },
    })).toThrow("changes committed, backup cleanup failed");
    expect(readFileSync(join(project, "a.ts"), "utf8")).toBe("new a");
    expect(readFileSync(join(project, "b.ts"), "utf8")).toBe("new b");
    expect(readFileSync(join(project, ".moeicons", "install-metadata.json"), "utf8")).toBe(next);
  });

  it("retains a user file created after validation and before commit", () => {
    const target = join(project, "a.ts");
    const plan = createInstallPlan(project, { "a.ts": "generated" });
    expect(() => executeInstallPlan(plan, {
      ...fs,
      writeFileSync: (path, data, options) => {
        writeFileSync(path, data, options);
        if (String(path).includes(".reconcile-staging-")) writeFileSync(target, "user content");
      },
    })).toThrow("file changed since planning");
    expect(readFileSync(target, "utf8")).toBe("user content");
  });

  it("rejects an owned file changed during staging", () => {
    writeFileSync(join(project, "a.ts"), "old");
    mkdirSync(join(project, ".moeicons"));
    const metadata: InstallMetadata = {
      schemaVersion: 1, artifactVersion: "0.0.1", tier: "free", target: "react",
      descriptorSha256: "a".repeat(64), artifactSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), installedAt: "2026-09-29T00:00:00.000Z",
      managedFiles: { "a.ts": sha256Bytes("old") },
    };
    writeFileSync(join(project, ".moeicons", "install-metadata.json"), serializeInstallMetadata(metadata));
    expect(() => executeInstallPlan(createInstallPlan(project, { "a.ts": "new" }), {
      ...fs,
      writeFileSync: (path, data, options) => {
        writeFileSync(path, data, options);
        if (String(path).includes(".reconcile-staging-")) writeFileSync(join(project, "a.ts"), "user edit");
      },
    })).toThrow("file changed since planning");
    expect(readFileSync(join(project, "a.ts"), "utf8")).toBe("user edit");
  });

  it("does not delete a concurrent edit while rolling back a later rename failure", () => {
    const first = join(project, "a.ts");
    const plan = createInstallPlan(project, { "a.ts": "generated a", "b.ts": "generated b" });
    let renames = 0;
    expect(() => executeInstallPlan(plan, {
      ...fs,
      renameSync: (from, to) => {
        renames += 1;
        if (renames === 2) {
          writeFileSync(first, "user edit");
          throw new Error("simulated later rename failure");
        }
        return renameSync(from, to);
      },
    })).toThrow("reconcile failed");
    expect(readFileSync(first, "utf8")).toBe("user edit");
    expect(existsSync(join(project, "b.ts"))).toBe(false);
  });
});
