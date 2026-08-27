import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTarGz } from "../../src/project/tar-gz.js";
import { bundledSourceVersion, DESCRIPTOR_NAME, DESCRIPTOR_SHA_NAME } from "../../src/core/free-download.js";
import type { ReleaseTarget, ReleaseTargetMetadata } from "../../src/core/release-descriptor.js";

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Indepedent mirror of the code-library packer's subtreeHash (DFS, localeCompare). */
function subtreeHash(files: Readonly<Record<string, string>>): ReleaseTargetMetadata {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  const namesAt = (prefix: string): string[] => {
    const names = new Set<string>();
    for (const rel of Object.keys(files)) {
      if (!prefix || rel.startsWith(`${prefix}/`)) {
        const rest = prefix ? rel.slice(prefix.length + 1) : rel;
        const slash = rest.indexOf("/");
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  };
  const walk = (prefix: string): void => {
    for (const name of namesAt(prefix)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const source = files[rel];
      if (source !== undefined) {
        const bytes = Buffer.from(source, "utf8");
        hash.update(rel).update("\0").update(bytes).update("\0");
        fileCount += 1;
        byteCount += bytes.byteLength;
      } else {
        walk(rel);
      }
    }
  };
  walk("");
  return { path: "", sha256: hash.digest("hex"), fileCount, byteCount };
}

const SVG = '<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>\n';

/** Per-target subtree content used by the free release fixture. */
export function targetSubtreeFiles(): Readonly<Record<ReleaseTarget, Readonly<Record<string, string>>>> {
  return {
    react: {
      "index.js": "export const reactTarget = true;\n",
      "types.d.ts": "export interface IconProps {}\n",
      "moe-outline/index.js": "export const arrowBoldRight = () => {};\n",
    },
    vue: {
      "index.js": "export const vueTarget = true;\n",
      "types.d.ts": "export interface IconProps {}\n",
    },
    vanilla: {
      "index.js": "export function createIcon() { return document.createElementNS('http://www.w3.org/2000/svg', 'svg'); }\n",
      "types.d.ts": "export function createIcon(): SVGElement;\n",
    },
    assets: {
      "manifest.json": `${JSON.stringify(
        {
          schemaVersion: 1,
          assets: [
            { path: "moe-outline/arrow-bold-right.svg", size: Buffer.byteLength(SVG), sha256: sha256(SVG) },
          ],
        },
        null,
        2,
      )}\n`,
      "moe-outline/arrow-bold-right.svg": SVG,
    },
  };
}

/**
 * Write a GitHub-Release-shaped free fixture directory for E1/E2 tests. The
 * archive contains `catalog.json` plus the four target subtrees, and the
 * descriptor records per-target subtree `targetMetadata` plus a metadata
 * archive (`metadata/{MANUAL.md,catalog.json,manifest.json}`) like the real
 * code-library release packer. `tamperTarget` swaps one file in the named
 * subtree so its subtree hash no longer matches the recorded metadata while the
 * whole-archive checksum still verifies.
 */
export function writeFreeReleaseFixture(
  dir: string,
  options: {
    readonly corruptArtifact?: boolean;
    readonly wrongDescriptorSha?: boolean;
    readonly version?: string;
    readonly useBundledCatalog?: boolean;
    readonly tamperTarget?: ReleaseTarget;
    readonly omitMetadata?: boolean;
    readonly corruptMetadata?: boolean;
    readonly tier?: "free" | "pro";
  } = {},
): {
  readonly version: string;
  readonly freeName: string;
  readonly descriptorSha: string;
  readonly freeSha: string;
  readonly catalogSha: string;
  readonly metadataSha: string;
  readonly metadataName: string;
} {
  const version = options.version ?? bundledSourceVersion();
  const catalog = options.useBundledCatalog
    ? `${JSON.stringify({ ...JSON.parse(readFileSync(join(import.meta.dirname, "../../src/catalog/catalog.json"), "utf8")), catalogVersion: version, sourceVersion: version })}\n`
    : JSON.stringify({
    schemaVersion: 1,
    catalogVersion: version,
    sourceVersion: version,
    sourceCommit: "a".repeat(40),
    generatorCommit: "b".repeat(40),
    styleGroups: [],
    icons: [],
    });
  const catalogSha = sha256(catalog);
  const subtrees = targetSubtreeFiles();
  const targetMetadata = Object.fromEntries(
    (Object.keys(subtrees) as ReleaseTarget[]).map((target) => [
      target,
      { ...subtreeHash(subtrees[target]), path: target },
    ]),
  );
  const archiveFiles: Record<string, string> = { "catalog.json": catalog };
  for (const [target, files] of Object.entries(subtrees)) {
    for (const [rel, content] of Object.entries(files)) {
      let contentForArchive = content;
      if (target === options.tamperTarget) {
        if (rel.endsWith(".svg")) {
          contentForArchive = '<svg viewBox="0 0 24 24"><path d="M9 9"/></svg>\n';
        } else if (rel === "index.js") {
          contentForArchive = `// tampered\n${content}`;
        } else if (rel === "manifest.json") {
          contentForArchive = content.replace('"path": "moe-outline/arrow-bold-right.svg"', '"path": "moe-outline/ui-search.svg"');
        }
      }
      archiveFiles[`${target}/${rel}`] = contentForArchive;
    }
  }
  const tgz = createTarGz(archiveFiles);
  const freeSha = sha256(tgz);
  const freeName = `moe-icons-free-${version}.tgz`;

  const manualMd = "# Moeicons free manual\n\nQuery catalog.json for icons.\n";
  const tier = options.tier ?? "free";
  const manifestJson = JSON.stringify(
    {
      schemaVersion: 1,
      tier,
      libraryVersion: version,
      manualVersion: version,
      catalogVersion: version,
      cliVersion: "0.0.0",
      generatedAt: { sourceCommit: "a".repeat(40), generatorCommit: "b".repeat(40) },
      targets: ["react", "vue", "vanilla", "assets"],
      dependencies: { react: { react: ">=17.0.0" }, vue: { vue: ">=3.2.0" }, vanilla: {}, assets: {} },
      files: {
        "MANUAL.md": { size: Buffer.byteLength(manualMd), sha256: sha256(manualMd) },
        "catalog.json": { size: Buffer.byteLength(catalog), sha256: catalogSha },
      },
    },
    null,
    2,
  );
  const metadataName = `moe-icons-free-metadata-${version}.tgz`;
  const metadataFiles: Record<string, string> = {
    "metadata/MANUAL.md": options.corruptMetadata ? "# tampered\n" : manualMd,
    "metadata/catalog.json": catalog,
    "metadata/manifest.json": manifestJson,
  };
  const metadataTgz = options.omitMetadata ? undefined : createTarGz(metadataFiles);
  const metadataSha = metadataTgz ? sha256(metadataTgz) : "";

  const descriptor = {
    fullVersion: version,
    free: {
      filename: freeName,
      sha256: freeSha,
      styleGroups: ["moe-outline"],
      styleGroupCount: 1,
      targets: Object.keys(targetMetadata) as ReleaseTarget[],
      targetMetadata,
      ...(metadataTgz
        ? {
            metadata: {
              filename: metadataName,
              sha256: metadataSha,
              size: metadataTgz.byteLength,
              files: {
                "MANUAL.md": {
                  size: Buffer.byteLength(metadataFiles["metadata/MANUAL.md"] ?? ""),
                  sha256: sha256(metadataFiles["metadata/MANUAL.md"] ?? ""),
                },
                "catalog.json": { size: Buffer.byteLength(catalog), sha256: catalogSha },
                "manifest.json": { size: Buffer.byteLength(manifestJson), sha256: sha256(manifestJson) },
              },
            },
          }
        : {}),
    },
    catalog: { filename: "catalog.json", sha256: catalogSha, schemaVersion: 1, iconCount: 0, styleGroupCount: 0 },
  };
  const descriptorJson = `${JSON.stringify(descriptor, null, 2)}\n`;
  const descriptorSha = sha256(descriptorJson);
  writeFileSync(join(dir, DESCRIPTOR_NAME), descriptorJson);
  writeFileSync(
    join(dir, DESCRIPTOR_SHA_NAME),
    `${options.wrongDescriptorSha ? "f".repeat(64) : descriptorSha}  ${DESCRIPTOR_NAME}\n`,
  );
  writeFileSync(join(dir, freeName), options.corruptArtifact ? Buffer.from("not-a-tgz") : Buffer.from(tgz));
  if (metadataTgz) writeFileSync(join(dir, metadataName), Buffer.from(metadataTgz));
  return { version, freeName, descriptorSha, freeSha, catalogSha, metadataSha, metadataName };
}