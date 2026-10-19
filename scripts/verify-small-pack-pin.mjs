import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_FILES = ["candidate-set.cjs", "tar-read.cjs"];
const EXPECTED_CONTRACTS = ["candidate-set-v1.schema.json"];
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`small-pack vendor pin: ${message}`);
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} has unexpected or missing fields`);
}

function readRegular(path, maximumBytes, label) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes, `${label} is outside its file/size budget`);
  const bytes = readFileSync(path);
  assert(bytes.byteLength === stat.size, `${label} changed while being read`);
  return bytes;
}

export function verifySmallPackPin(root = DEFAULT_ROOT) {
  const vendor = join(root, "src", "core", "small-pack");
  const pinBytes = readRegular(join(vendor, "PIN.json"), 4096, "PIN.json");
  let pin;
  try { pin = JSON.parse(pinBytes.toString("utf8")); }
  catch { assert(false, "PIN.json is invalid JSON"); }
  exactKeys(pin, ["schemaVersion", "sourceCommit", "files", "contracts"], "PIN.json");
  assert(pin.schemaVersion === 2 && COMMIT.test(pin.sourceCommit || ""), "PIN schema or full Generator source commit is invalid");
  exactKeys(pin.files, EXPECTED_FILES, "PIN files");
  for (const name of EXPECTED_FILES) {
    assert(SHA256.test(pin.files[name] || ""), `${name} pin is not a lowercase SHA-256`);
    const bytes = readRegular(join(vendor, name), 256 * 1024, name);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert(digest === pin.files[name], `${name} differs from its pinned bytes`);
  }
  exactKeys(pin.contracts, EXPECTED_CONTRACTS, "PIN contracts");
  for (const name of EXPECTED_CONTRACTS) {
    assert(SHA256.test(pin.contracts[name] || ""), `${name} contract pin is not a lowercase SHA-256`);
    const bytes = readRegular(join(vendor, name), 64 * 1024, name);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert(digest === pin.contracts[name], `${name} differs from its pinned bytes`);
  }
  return { sourceCommit: pin.sourceCommit, files: { ...pin.files }, contracts: { ...pin.contracts } };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifySmallPackPin(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT);
    process.stdout.write(`small-pack vendor pin verified at ${result.sourceCommit}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
