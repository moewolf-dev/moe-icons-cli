import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/commands/parser.js";
import { CliError } from "../src/errors/index.js";
import { applyPlannedChanges } from "../src/project/anchors/apply.js";

describe("parser: doctor + init dry-run + unknown options", () => {
  it("parses doctor", () => {
    expect(parseArgs(["doctor"]).command).toEqual({ name: "doctor" });
  });

  it("parses doctor --json --check", () => {
    const r = parseArgs(["doctor", "--json", "--check"]);
    expect(r.command).toMatchObject({ name: "doctor", check: true });
    expect(r.json).toBe(true);
  });

  it("parses init --dry-run", () => {
    expect(parseArgs(["init", "--dry-run"]).command).toEqual({ name: "init", dryRun: true });
  });

  it("rejects unknown options with a stable validation error", () => {
    for (const argv of [["doctor", "--nope"], ["init", "--nope"], ["install", "--bogus"], ["--bogus"]]) {
      try {
        parseArgs(argv);
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).code).toBe("VALIDATION_ERROR");
        expect((error as CliError).message).toMatch(/unknown option/);
      }
    }
  });

  it("rejects unknown commands", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/unknown command/);
  });
});

function makeFs() {
  return {
    existsSync: (p: string) => require("node:fs").existsSync(p),
    readTextFileSync: (p: string) => readFileSync(p, "utf8"),
    mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
    writeTextFileSync: (p: string, c: string) => writeFileSync(p, c),
    renameSync: (a: string, b: string) => require("node:fs").renameSync(a, b),
    rmSync: (p: string, o?: { recursive?: boolean; force?: boolean }) =>
      require("node:fs").rmSync(p, { recursive: true, force: true }),
  };
}

describe("apply: transactional plan with rollback + idempotency", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-apply-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a missing file and reports written", () => {
    const fs_ = makeFs();
    const result = applyPlannedChanges(
      dir,
      [{ kind: "create", path: "moeicons.config.jsonc", before: undefined, after: "{}" }],
      fs_,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyConfigured).toBe(false);
      expect(result.written).toContain("moeicons.config.jsonc");
    }
    expect(readFileSync(join(dir, "moeicons.config.jsonc"), "utf8")).toBe("{}");
  });

  it("is idempotent on the second identical run", () => {
    const fs_ = makeFs();
    const changes = [
      { kind: "replace" as const, path: "src/main.tsx", before: "a", after: "ab" },
    ];
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.tsx"), "ab");
    const first = applyPlannedChanges(dir, changes, fs_);
    expect(first.ok && first.alreadyConfigured).toBe(true);
  });

  it("restores originals when a write fails mid-way", () => {
    const fs_ = makeFs();
    const original = "original content";
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a", "one.txt"), original);
    const changes = [
      { kind: "replace" as const, path: "a/one.txt", before: original, after: "changed" },
      { kind: "replace" as const, path: "b/two.txt", before: undefined, after: "x" },
    ];
    // Make the second target fail by creating an unwritable-ish path (dir with
    // an existing directory at the file location is fine; instead simulate via
    // a write hook that throws for a specific path).
    const failing = {
      ...fs_,
      writeTextFileSync: (p: string, c: string) => {
        if (p.endsWith("two.txt")) throw new Error("boom");
        fs_.writeTextFileSync(p, c);
      },
    };
    const result = applyPlannedChanges(dir, changes, failing);
    expect(result.ok).toBe(false);
    // original must be restored byte-for-byte
    expect(readFileSync(join(dir, "a", "one.txt"), "utf8")).toBe(original);
  });
});
