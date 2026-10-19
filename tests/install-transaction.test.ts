import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstallPlan, executeInstallPlan, executeManagedReconcile, recoverManagedReconcile, type StagedInstallFile } from "../src/project/install.js";
import { serializeInstallMetadata, sha256Bytes, type InstallMetadata } from "../src/project/install-metadata.js";
import { serializePackageInstallMetadata, type PackageInstallMetadata } from "../src/project/package-install-metadata.js";

const fs = { existsSync, mkdirSync, renameSync, rmSync, writeFileSync };
const fsWithCopy = { ...fs, readFileSync, readdirSync, copyFileSync };
const packageMetadata = (content: string, fullVersion: string): PackageInstallMetadata => {
  const catalog = '{"schemaVersion":1}\n';
  const packageSha256 = sha256Bytes(`package:${content}`);
  return {
    schemaVersion: 2,
    candidate: {
      schemaVersion: 1, tier: "free", fullVersion,
      sourceCommit: "a".repeat(40), generatorCommit: sha256Bytes(content).slice(0, 40),
      packageSetSha256: sha256Bytes(`set:${content}`), candidateRootSha256: sha256Bytes(`root:${content}`),
    },
    target: "react", resourceKeys: ["code/free/react/moe-outline"],
    packages: [{ resourceKey: "code/free/react/moe-outline", packageSha256, dependencies: [] }],
    catalogSha256: sha256Bytes(catalog), installedAt: "2026-10-17T00:00:00Z",
    managedFiles: { ".moeicons/catalog.json": sha256Bytes(catalog), "src/icon.ts": sha256Bytes(content) },
    targetSha256: sha256Bytes(content), targetFileCount: 1, targetByteCount: Buffer.byteLength(content),
  };
};

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

  it("commits a staged install file and removes its private staging tree", () => {
    const operation = randomUUID();
    const stageRoot = `.moeicons/.package-stage-${operation}`;
    const source = join(project, stageRoot, "target", "icon.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "export const icon = true;\n");
    const staged: StagedInstallFile = {
      kind: "staged-file", path: `${stageRoot}/target/icon.ts`,
      sha256: sha256Bytes("export const icon = true;\n"),
    };

    executeInstallPlan(createInstallPlan(project, { "src/icon.ts": staged }), fs);

    expect(readFileSync(join(project, "src/icon.ts"), "utf8")).toBe("export const icon = true;\n");
    expect(existsSync(join(project, stageRoot))).toBe(false);
  });

  it("rejects a staged checksum mismatch before touching managed files", () => {
    const operation = randomUUID();
    const stageRoot = `.moeicons/.package-stage-${operation}`;
    const source = join(project, stageRoot, "icon.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "staged bytes");
    writeFileSync(join(project, "icon.ts"), "existing bytes");

    expect(() => executeManagedReconcile(project, {
      "icon.ts": { kind: "staged-file", path: `${stageRoot}/icon.ts`, sha256: "a".repeat(64) },
    }, [], fsWithCopy)).toThrow("staged install source checksum mismatch");
    expect(readFileSync(join(project, "icon.ts"), "utf8")).toBe("existing bytes");
    expect(readFileSync(source, "utf8")).toBe("staged bytes");
  });

  it("restores old bytes if installing a staged file fails during rename", () => {
    const operation = randomUUID();
    const stageRoot = `.moeicons/.package-stage-${operation}`;
    const source = join(project, stageRoot, "icon.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "new bytes");
    writeFileSync(join(project, "icon.ts"), "old bytes");
    const staged: StagedInstallFile = {
      kind: "staged-file", path: `${stageRoot}/icon.ts`, sha256: sha256Bytes("new bytes"),
    };
    const io = {
      ...fsWithCopy,
      renameSync: (from: Parameters<typeof renameSync>[0], to: Parameters<typeof renameSync>[1]) => {
        if (String(from).includes(".reconcile-staging-") && String(to).endsWith("/icon.ts")) {
          throw new Error("simulated staged rename failure");
        }
        return renameSync(from, to);
      },
    };

    expect(() => executeManagedReconcile(project, { "icon.ts": staged }, [], io)).toThrow("simulated staged rename failure");
    expect(readFileSync(join(project, "icon.ts"), "utf8")).toBe("old bytes");
    expect(readFileSync(source, "utf8")).toBe("new bytes");
  });

  it("cleans staged sources when recovery finds a committed transaction", () => {
    const operation = randomUUID();
    const stageRoot = `.moeicons/.package-stage-${operation}`;
    const source = join(project, stageRoot, "icon.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "new bytes");
    const staged: StagedInstallFile = {
      kind: "staged-file", path: `${stageRoot}/icon.ts`, sha256: sha256Bytes("new bytes"),
    };
    let failCleanup = true;
    const io = {
      ...fsWithCopy,
      rmSync: (path: Parameters<typeof rmSync>[0], options: Parameters<typeof rmSync>[1]) => {
        if (failCleanup && String(path).endsWith(`/${stageRoot}`)) {
          failCleanup = false;
          throw new Error("simulated process stop during source cleanup");
        }
        return rmSync(path, options);
      },
    };

    expect(() => executeManagedReconcile(project, { "icon.ts": staged }, [], io)).toThrow("changes committed, backup cleanup failed");
    expect(readFileSync(join(project, "icon.ts"), "utf8")).toBe("new bytes");
    expect(recoverManagedReconcile(project, fsWithCopy)).toBe(1);
    expect(existsSync(join(project, stageRoot))).toBe(false);
    expect(readdirSync(join(project, ".moeicons")).some((name) => name.startsWith(".reconcile-backup-"))).toBe(false);
  });

  it("uses v2 managed-file hashes when replacing an existing package-set install", () => {
    const catalog = '{"schemaVersion":1}\n';
    const initial = packageMetadata("old icon\n", "1.2.3");
    executeInstallPlan(createInstallPlan(project, {
      ".moeicons/catalog.json": catalog,
      "src/icon.ts": "old icon\n",
      ".moeicons/install-metadata.json": serializePackageInstallMetadata(initial),
    }), fs);

    const updated = packageMetadata("new icon\n", "1.2.4");
    executeInstallPlan(createInstallPlan(project, {
      ".moeicons/catalog.json": catalog,
      "src/icon.ts": "new icon\n",
      ".moeicons/install-metadata.json": serializePackageInstallMetadata(updated),
    }), fs);

    expect(readFileSync(join(project, "src/icon.ts"), "utf8")).toBe("new icon\n");
    expect(readFileSync(join(project, ".moeicons/install-metadata.json"), "utf8")).toBe(serializePackageInstallMetadata(updated));
  });
});
