import { createHash } from "node:crypto";

/**
 * E2E-G1A/G2: normalized payload hash deciding whether a `main` push changes
 * the CLI npm tarball bytes and therefore needs a new `cliVersion`.
 *
 * Contract (TODO §4.4): compare a normalized content hash over the files that
 * `npm pack` would ship, EXCLUDING the version fields that automation itself
 * writes (package.json version, lockfile version fields) and generated
 * timestamps. Comparing "old pre-bump tarball" vs "new final tarball" directly
 * is forbidden because the version fields would create a recursive bump.
 *
 * The output of this module is compared to the last published CLI release's
 * recorded payloadHash. Equal => run CI only, do not publish.
 */

const EXCLUDE_KEYS = new Set(["version", "resolved", "integrity"]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .filter((key) => !EXCLUDE_KEYS.has(key))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Filter a package.json into its publish-relevant, version-excluded form. */
export function normalizePackageJsonForPayload(pkg) {
  const clone = { ...pkg };
  delete clone.version;
  return clone;
}

/** Deterministic per-file content for the pack payload. */
export function payloadFileEntries(files) {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      return `${name}\0${bytes.byteLength}\0${bytes.toString("base64")}`;
    })
    .join("\n");
}

/**
 * Compute the normalized payload hash from { files, packageJson, lockfile }.
 * `files` are the raw file contents (`npm pack --json` -> files[]) that will be
 * shipped; `packageJson` and `lockfile` have their version/resolved/integrity
 * fields neutralised before hashing so version bumps don't recurse.
 */
export function computePayloadHash({
  files,
  packageJson,
  lockfile = undefined,
}) {
  const canonical = [
    canonicalJson(normalizePackageJsonForPayload(packageJson)),
    lockfile ? canonicalJson(lockfile) : "",
    payloadFileEntries(files),
  ].join("\n---\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Files entry shape from `npm pack --json` (filtered in the workflow). */
export function packFilesToEntries(packFiles) {
  return packFiles.map(({ path, size, mode }) => ({ path, size, mode }));
}
