import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// package-relative path inside config-package -> local file name in CLI copy.
const MAPPING = {
  "src/render-config.cjs": "render-config.cjs",
  "src/validate-config.cjs": "validate-config.cjs",
  "schema/moeicons-config.schema.json": "moeicons-config.schema.json",
  "templates/moeicons.config.jsonc": "moeicons.config.jsonc",
};

// Resolve the code-library checkout that owns config-package.
// Order: MOEICONS_CODE_LIBRARY_REPO env > sibling ../moe-icons-code-library.
function resolveCodeLibrary() {
  if (process.env.MOEICONS_CODE_LIBRARY_REPO) {
    return resolve(process.env.MOEICONS_CODE_LIBRARY_REPO);
  }
  const sibling = resolve(root, "..", "moe-icons-code-library");
  if (
    existsSync(join(sibling, "config-package", "src", "render-config.cjs")) &&
    existsSync(join(sibling, "package.json"))
  ) {
    return sibling;
  }
  return undefined;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitHead(repo) {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Sync the canonical config-package generated copy from a pinned
 * moe-icons-code-library checkout into CLI `src/generated/config-package/`.
 *
 * When the code-library checkout has `config-package/generated/manifest.json`
 * (produced by `generate-config-package-manifest.cjs`), each file digest is
 * verified against it before copying. SOURCE.json records the code-library
 * commit and the digest of every copied file. The committed copy is what
 * `moeicons init` uses offline; it never accesses the network at first init.
 */
function main() {
  const repo = resolveCodeLibrary();
  if (!repo) {
    console.error(
      "error: could not resolve moe-icons-code-library. Set MOEICONS_CODE_LIBRARY_REPO.",
    );
    process.exit(1);
  }
  const srcPkg = join(repo, "config-package");
  const manifestPath = join(srcPkg, "generated", "manifest.json");
  let manifest = null;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const pkgRel of Object.keys(MAPPING)) {
      const expected = manifest.files?.[pkgRel];
      if (!expected) {
        console.error(`error: generated manifest missing entry for ${pkgRel}`);
        process.exit(1);
      }
    }
  }

  const outDir = join(root, "src", "config-package", "generated");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const files = {};
  for (const [pkgRel, localName] of Object.entries(MAPPING)) {
    const srcFile = join(srcPkg, pkgRel);
    if (!existsSync(srcFile)) {
      console.error(`error: missing ${pkgRel} in code-library config-package`);
      process.exit(1);
    }
    if (manifest) {
      const expected = manifest.files[pkgRel].sha256;
      const actual = sha256(srcFile);
      if (expected !== actual) {
        console.error(`error: ${pkgRel} digest does not match code-library generated manifest`);
        process.exit(1);
      }
    }
    const outFile = join(outDir, localName);
    cpSync(srcFile, outFile);
    files[localName] = { size: statSync(srcFile).size, sha256: sha256(srcFile) };
  }
  const source = {
    schemaVersion: 1,
    sourceRepo: "moewolf-dev/moe-icons-code-library",
    sourceDir: "config-package",
    sourceCommit: gitHead(repo),
    files,
  };
  writeFileSync(join(outDir, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`);
  console.log(
    `synced config-package from ${repo} @ ${source.sourceCommit} to src/config-package/generated`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
