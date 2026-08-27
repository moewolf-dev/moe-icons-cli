#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * E4: registry idempotency preflight. Reads the local package.json version and
 * checks the npm registry (read-only) for that exact version. Exits 0 when the
 * version is absent (safe to publish) and non-zero when it is already
 * published. Wired as `release:preflight` and `prepublishOnly`; never runs
 * during `npm ci`/`npm install`.
 *
 * Usage:
 *   node scripts/release-preflight.mjs            # human-readable output
 *   node scripts/release-preflight.mjs --json     # machine-readable output
 *
 * Env overrides (for tests / mirrors):
 *   MOEICONS_PREFLIGHT_REGISTRY_URL
 */

const REGISTRY_URL = "https://registry.npmjs.org/@moewolf%2fmoe-icons-cli";
const DEFAULT_TIMEOUT_MS = 10_000;
const PACKAGE_NAME = "@moewolf/moe-icons-cli";

/**
 * Query the npm package document for an exact version. Dependency-free: takes
 * an injectable fetch (defaults to the Node 22+ global) so unit tests can mock
 * the network.
 */
export async function checkVersionPublished({
  version,
  registryUrl = REGISTRY_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
} = {}) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("preflight: package.json version is missing or invalid");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchFn(registryUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    throw new Error(
      `network error while checking npm registry (${registryUrl}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
  // A 404 means the package has never been published; the version is absent.
  if (response.status === 404) return { published: false };
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("npm registry returned an invalid response");
  }
  const versions =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value.versions ?? undefined)
      : undefined;
  const published =
    versions !== null &&
    typeof versions === "object" &&
    !Array.isArray(versions) &&
    Object.prototype.hasOwnProperty.call(versions, version);
  return { published };
}

function printHuman(ok, lines) {
  if (ok) console.log(lines.join("\n"));
  else console.error(lines.join("\n"));
}

/** Run the preflight; returns a process exit code without exiting. */
export async function runPreflight(argv, env) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const registryUrl = env.MOEICONS_PREFLIGHT_REGISTRY_URL || REGISTRY_URL;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let version;
  try {
    version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch (error) {
    const message = `cannot read package.json: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (json) console.log(JSON.stringify({ ok: false, message }));
    else printHuman(false, [`preflight failed: ${message}`]);
    return 1;
  }
  try {
    const result = await checkVersionPublished({ version, registryUrl });
    if (result.published) {
      const message = `already published: ${PACKAGE_NAME}@${version}`;
      if (json) console.log(JSON.stringify({ ok: false, published: true, version, message }));
      else printHuman(false, [`preflight blocked: ${message}`]);
      return 1;
    }
    if (json) console.log(JSON.stringify({ ok: true, published: false, version }));
    else printHuman(true, [`preflight ok: ${PACKAGE_NAME}@${version} is not published yet`]);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, version, message }));
    else printHuman(false, [`preflight failed: ${message}`]);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runPreflight(process.argv, process.env).then((code) => {
    process.exitCode = code;
  });
}
