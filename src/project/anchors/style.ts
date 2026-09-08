import { join } from "node:path";
import type { AnchorResult } from "./types.js";
import type { DetectorIo } from "./helpers.js";

/**
 * Styling anchor (E2E-B4). This anchor is OPTIONAL: absence of Tailwind or CSS
 * is a warning/`missing` result, never a hard failure. The detector is
 * read-only: it resolves the CSS entry, checks whether moeicons styles are
 * imported, and reports Tailwind status as evidence. It only offers a safe fix
 * (a single fixed style import appended to an unambiguous CSS file).
 */

const CSS_CANDIDATES = [
  "src/index.css",
  "src/style.css",
  "src/styles.css",
  "app/globals.css",
  "src/app/globals.css",
];

export interface StyleAnchorOptions {
  readonly root: string;
  readonly io: DetectorIo;
  /** Confirmed style path stored in config (preferred source). */
  readonly confirmedStyle?: string;
  /** true when the target is assets-only. */
  readonly assetsOnly?: boolean;
}

export function findCssCandidates(io: DetectorIo, root: string): readonly string[] {
  return CSS_CANDIDATES.filter((rel) => io.existsSync(join(root, rel)));
}

function cssImportsMoeicons(source: string): boolean {
  // CSS entry may import a stylesheet that carries the moeicons class base, or a
  // JS/TS entry imports "moeicons/styles.css". Keep both cheap checks.
  return /moeicons/.test(source);
}

export function inspectStyleAnchor(options: StyleAnchorOptions): AnchorResult {
  const { io, root, assetsOnly } = options;
  if (assetsOnly) {
    return {
      kind: "style",
      status: "not-required",
      candidates: [],
      evidence: ["assets-only target requires no styling integration"],
      fixes: [],
    };
  }
  const candidates =
    options.confirmedStyle && io.existsSync(join(root, options.confirmedStyle))
      ? [options.confirmedStyle]
      : findCssCandidates(io, root);

  if (candidates.length === 0) {
    return {
      kind: "style",
      status: "missing",
      candidates: CSS_CANDIDATES,
      evidence: ["no CSS entry found; styling integration is optional (warning only)"],
      fixes: [],
    };
  }
  if (candidates.length > 1) {
    return {
      kind: "style",
      status: "ambiguous",
      candidates,
      evidence: [`multiple CSS entry candidates: ${candidates.join(", ")}`],
      fixes: [],
    };
  }
  const rel = candidates[0] ?? "";
  const full = join(root, rel);
  let source = "";
  try {
    source = io.readFileSync(full);
  } catch {
    source = "";
  }
  if (cssImportsMoeicons(source)) {
    return {
      kind: "style",
      status: "ok",
      path: full,
      candidates: [],
      evidence: [`moeicons styles referenced in ${rel}`],
      fixes: [],
    };
  }
  return {
    kind: "style",
    status: "missing",
    path: full,
    candidates: [],
    evidence: [
      `CSS entry: ${rel}`,
      "no moeicons style import present; safe single-import plan available",
    ],
    fixes: [
      {
        kind: "replace",
        path: rel,
        before: source,
        after: `${source}\n@import "./moeicons/styles.css";\n`,
      },
    ],
  };
}
