import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors/index.js";
import { CLSX_VERSION_RANGE, TAILWIND_MERGE_VERSION_RANGE } from "../generator/cn.js";
import { applyEdits, modify } from "jsonc-parser";

/**
 * H3: only rewrite Tailwind v3 configs whose `content` is a static string-array
 * literal. Other shapes get a precise manual hint. Tailwind v4 → typed error.
 */

export type TailwindDetectResult =
  | { readonly kind: "missing" }
  | { readonly kind: "v3"; readonly configPath: string; readonly source: string }
  | { readonly kind: "v4"; readonly configPath: string }
  | { readonly kind: "unknown"; readonly configPath: string; readonly source: string };

const CONFIG_CANDIDATES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
] as const;

export function findTailwindConfig(projectRoot: string): string | undefined {
  for (const name of CONFIG_CANDIDATES) {
    const path = join(projectRoot, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function packageDeclaresTailwindV4(projectRoot: string): boolean {
  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const range = pkg.dependencies?.tailwindcss ?? pkg.devDependencies?.tailwindcss;
    if (!range) return false;
    return range.startsWith("^4") || range.startsWith("~4") || range.startsWith(">=4") || /^4(\.|$)/.test(range);
  } catch {
    return false;
  }
}

export function detectTailwind(projectRoot: string): TailwindDetectResult {
  const configPath = findTailwindConfig(projectRoot);
  if (packageDeclaresTailwindV4(projectRoot)) {
    return { kind: "v4", configPath: configPath ?? join(projectRoot, "package.json") };
  }
  if (!configPath) return { kind: "missing" };
  const source = readFileSync(configPath, "utf8");
  if (/\b@tailwindcss\/(vite|postcss)\b/.test(source)) {
    return { kind: "v4", configPath };
  }
  if (/content\s*:/.test(source)) return { kind: "v3", configPath, source };
  return { kind: "unknown", configPath, source };
}

const CONTENT_ARRAY_RE = /(content\s*:\s*)\[([\s\S]*?)\]/;

export type ContentInjectResult =
  | { readonly ok: true; readonly changed: boolean; readonly nextSource: string }
  | { readonly ok: false; readonly reason: "unsupported-shape"; readonly hint: string };

/** Idempotently append a glob to a static `content: [ ... ]` array. */
export function injectContentGlob(source: string, glob: string): ContentInjectResult {
  if (source.includes(glob)) {
    return { ok: true, changed: false, nextSource: source };
  }
  const match = CONTENT_ARRAY_RE.exec(source);
  if (!match || match.index === undefined) {
    return {
      ok: false,
      reason: "unsupported-shape",
      hint: `Could not safely edit Tailwind content; add ${JSON.stringify(glob)} to content manually.`,
    };
  }
  const full = match[0];
  if (/require\(|import\(|\.\.\./.test(full)) {
    return {
      ok: false,
      reason: "unsupported-shape",
      hint: `Tailwind content is not a static string array; add ${JSON.stringify(glob)} manually.`,
    };
  }
  const prefix = match[1] ?? "content: ";
  const body = match[2] ?? "";
  const trimmed = body.replace(/\s+$/, "");
  const needsComma = trimmed.length > 0 && !trimmed.trimEnd().endsWith(",");
  const insertion = `${needsComma ? "," : ""}\n    ${JSON.stringify(glob)}`;
  const nextArray = `${prefix}[${trimmed}${insertion}\n  ]`;
  return { ok: true, changed: true, nextSource: source.replace(full, nextArray) };
}

export function moeiconsContentGlob(outputDir: string): string {
  const normalized = outputDir.replace(/\\/g, "/").replace(/\/$/, "");
  return `./${normalized}/**/*.{js,ts,jsx,tsx,vue}`;
}

/**
 * Apply Tailwind content injection. Throws CliError(TAILWIND_VERSION_UNSUPPORTED)
 * for v4 when integration is requested.
 */
export function planTailwindIntegration(
  projectRoot: string,
  outputDir: string,
  options: { readonly noTailwind: boolean },
): {
  readonly files: readonly { path: string; content: string }[];
  readonly notes: readonly string[];
} {
  if (options.noTailwind) {
    return { files: [], notes: ["skipped Tailwind config (--no-tailwind)"] };
  }
  const detected = detectTailwind(projectRoot);
  if (detected.kind === "missing") {
    return { files: [], notes: ["no Tailwind config found; skipped content injection"] };
  }
  if (detected.kind === "v4") {
    throw new CliError(
      "TAILWIND_VERSION_UNSUPPORTED",
      "Tailwind CSS v4 was detected; this CLI release only auto-integrates Tailwind v3. Pass --no-tailwind to skip Tailwind config changes.",
    );
  }
  if (detected.kind === "unknown") {
    return {
      files: [],
      notes: [
        `Tailwind config ${detected.configPath} has no static content array; add ${JSON.stringify(moeiconsContentGlob(outputDir))} manually.`,
      ],
    };
  }
  const glob = moeiconsContentGlob(outputDir);
  const injected = injectContentGlob(detected.source, glob);
  if (!injected.ok) {
    return { files: [], notes: [injected.hint] };
  }
  if (!injected.changed) {
    return { files: [], notes: [`Tailwind content already includes ${glob}`] };
  }
  return {
    files: [{ path: detected.configPath, content: injected.nextSource }],
    notes: [`updated ${detected.configPath} content with ${glob}`],
  };
}

export function ensureClassMergeDependencies(source: string): {
  readonly nextSource: string;
  readonly changed: boolean;
  readonly notes: string[];
} {
  const notes: string[] = [];
  let pkg: {
    dependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  try {
    pkg = JSON.parse(source) as typeof pkg;
  } catch {
    return { nextSource: source, changed: false, notes: ["package.json is not valid JSON; skipped clsx/tailwind-merge"] };
  }
  const deps = { ...(pkg.dependencies ?? {}) };
  let changed = false;
  if (!deps.clsx) {
    deps.clsx = CLSX_VERSION_RANGE;
    changed = true;
    notes.push(`add dependencies.clsx ${CLSX_VERSION_RANGE}`);
  }
  if (!deps["tailwind-merge"]) {
    deps["tailwind-merge"] = TAILWIND_MERGE_VERSION_RANGE;
    changed = true;
    notes.push(`add dependencies.tailwind-merge ${TAILWIND_MERGE_VERSION_RANGE}`);
  }
  if (!changed) return { nextSource: source, changed: false, notes: ["clsx/tailwind-merge already declared"] };
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = source.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  const formattingOptions = { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol };
  if (!pkg.dependencies) {
    const closing = source.lastIndexOf("}");
    const beforeClosing = source.slice(0, closing);
    const whitespace = beforeClosing.match(/\s*$/)?.[0] ?? "";
    const body = beforeClosing.slice(0, beforeClosing.length - whitespace.length);
    const comma = Object.keys(pkg).length > 0 ? "," : "";
    const block = `${comma}${eol}${indent}"dependencies": {${eol}${indent}${indent}"clsx": ${JSON.stringify(CLSX_VERSION_RANGE)},${eol}${indent}${indent}"tailwind-merge": ${JSON.stringify(TAILWIND_MERGE_VERSION_RANGE)}${eol}${indent}}`;
    return { nextSource: `${body}${block}${whitespace}${source.slice(closing)}`, changed: true, notes };
  }
  let nextSource = source;
  if (!pkg.dependencies?.clsx) nextSource = applyEdits(nextSource, modify(nextSource, ["dependencies", "clsx"], CLSX_VERSION_RANGE, { formattingOptions }));
  if (!pkg.dependencies?.["tailwind-merge"]) nextSource = applyEdits(nextSource, modify(nextSource, ["dependencies", "tailwind-merge"], TAILWIND_MERGE_VERSION_RANGE, { formattingOptions }));
  return { nextSource, changed: true, notes };
}
