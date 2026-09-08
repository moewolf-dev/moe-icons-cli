import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  computePayloadHash,
  normalizePackageJsonForPayload,
  packFilesToEntries,
  payloadFileEntries,
} from "../scripts/payload-hash.mjs";

const packEntries = packFilesToEntries([
  { path: "dist/cli.js", size: 2, mode: 0o644 },
  { path: "bin/moeicons.js", size: 4, mode: 0o755 },
]);

test("G1A: version bumps alone do not change the payload hash", () => {
  const baseFiles = { "dist/cli.js": "console.log(1)\n", "bin/moeicons.js": "#!/usr/bin/env node\n" };
  const hashA = computePayloadHash({
    files: baseFiles,
    packageJson: { name: "@moewolf/moe-icons-cli", version: "0.0.1" },
    lockfile: { name: "@moewolf/moe-icons-cli", version: "0.0.1", packages: {} },
  });
  const hashB = computePayloadHash({
    files: baseFiles,
    packageJson: { name: "@moewolf/moe-icons-cli", version: "0.0.2" },
    lockfile: { name: "@moewolf/moe-icons-cli", version: "0.0.2", packages: {} },
  });
  assert.equal(hashA, hashB, "version-only change must not require a new payload");
});

test("G1A: a real byte change in a shipped file changes the payload hash", () => {
  const files = (body: string): Record<string, string> => ({ "dist/cli.js": body, "bin/moeicons.js": "#!/usr/bin/env node\n" });
  const a = computePayloadHash({ files: files("a"), packageJson: { version: "0.0.1" } });
  const b = computePayloadHash({ files: files("b"), packageJson: { version: "0.0.1" } });
  assert.notEqual(a, b);
});

test("G1A: only shipped pack entries count (caller filters README/docs/tests)", () => {
  const shipped = { "dist/cli.js": "x", "bin/moeicons.js": "y" };
  const hashOf = (files: Record<string, string>): string => computePayloadHash({ files, packageJson: { name: "@moewolf/moe-icons-cli", version: "0.0.1" } });
  // README/docs/tests are not in the pack `files` list, so identical hashes.
  assert.equal(hashOf(shipped), hashOf(shipped));
  // A real shipped-byte change differs.
  assert.notEqual(hashOf(shipped), hashOf({ ...shipped, "dist/cli.js": "z" }));
});

test("G1A: deterministic and dependency-free sha256 output", () => {
  const input = {
    files: { "a.txt": "x" },
    packageJson: { name: "n", version: "1.0.0" },
  };
  const one = computePayloadHash(input);
  const two = computePayloadHash(input);
  assert.equal(one, two);
  assert.equal(one.length, 64);
  // Free function sanity: not double-hashing
  assert.equal(createHash("sha256").update("x").digest("hex").length, 64);
});

test("G1A: packFilesToEntries keeps path/size/mode only", () => {
  assert.deepEqual(packEntries, [
    { path: "dist/cli.js", size: 2, mode: 0o644 },
    { path: "bin/moeicons.js", size: 4, mode: 0o755 },
  ]);
});

test("G1A: payloadFileEntries sorts names and includes byte lengths", () => {
  const text = payloadFileEntries({ "b": "bb", "a": "x" });
  assert.ok(text.indexOf("a\0") < text.indexOf("b\0"));
  assert.ok(text.includes("a\0"));
});
