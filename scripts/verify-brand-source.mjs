#!/usr/bin/env node
/**
 * Optional maintainer check: regenerate logo-ascii.ts from --input and compare
 * it to the committed constant. Not part of npm test / build / pack.
 *
 *   npm run verify:brand-source -- --input <svg>
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLogoAscii, parseArgv } from "./generate-logo-ascii.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED = join(ROOT, "src", "ui", "generated", "logo-ascii.ts");

try {
  const { input } = parseArgv(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "verify-brand-source-"));
  try {
    const output = join(dir, "logo-ascii.ts");
    await generateLogoAscii({ input, output });
    const committed = readFileSync(COMMITTED, "utf8");
    const generated = readFileSync(output, "utf8");
    if (committed !== generated) {
      process.stderr.write("error: committed logo-ascii.ts does not match regenerated output\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("ok: committed logo-ascii.ts matches regenerated output\n");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
