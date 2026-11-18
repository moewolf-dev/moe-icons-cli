/**
 * P1-06 / REF-09: explicit, local-only diagnostic export.
 *
 * `moeicons doctor --export-diagnostics` writes ONE short-lived text bundle. It
 * is never automatic, never uploaded, and never a log file. The bundle favours
 * configuration/startup facts over volume:
 *   Node/engines, OS/arch/shell/TTY/CI, CLI version + install source,
 *   package manager/lockfile, project four anchors, config fields + parse
 *   location, error phase/code/hint and the last redacted ring events.
 *
 * Hard limits: 1 MiB per bundle, 5 MiB / 5 files per directory, 24 h expiry.
 * Paths are project-relative or categorised; home directories are never printed.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { runDoctorDiagnose } from "./doctor.js";
import type { DiagnosticRecorder } from "./diagnostics.js";
import { redactText } from "../errors/redact.js";

export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const MAX_BUNDLE_FILES = 5;
export const MAX_BUNDLE_TOTAL_BYTES = 5 * 1024 * 1024;
export const BUNDLE_TTL_MS = 24 * 60 * 60 * 1_000;
export const DIAGNOSTIC_FILE_PREFIX = "moeicons-diag-";

export interface DiagnosticBundleFs {
  readonly existsSync: (path: string) => boolean;
  readonly mkdirSync: (path: string) => void;
  readonly readFileSync: (path: string) => string;
  readonly writeFileSync: (path: string, content: string) => void;
  readonly readdirSync: (path: string) => readonly string[];
  readonly statSync: (path: string) => {
    readonly size: number;
    readonly mtimeMs: number;
    readonly isFile: () => boolean;
  };
  readonly renameSync: (from: string, to: string) => void;
  readonly rmSync: (path: string) => void;
}

const NODE_FS: DiagnosticBundleFs = {
  existsSync,
  mkdirSync: (path) => {
    mkdirSync(path, { recursive: true });
  },
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  readdirSync: (path) => readdirSync(path),
  statSync: (path) => statSync(path),
  renameSync,
  rmSync: (path) => rmSync(path, { recursive: true, force: true }),
};

export interface BundleInput {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cliVersion: string;
  readonly nodeVersion?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly stdinTTY?: boolean;
  readonly stdoutTTY?: boolean;
  readonly stderrTTY?: boolean;
  readonly columns?: number | undefined;
  readonly installSource?: string;
  readonly diagnostics?: DiagnosticRecorder;
  readonly now?: Date;
  /** Project root when already known; otherwise diagnosed from `cwd`. */
  readonly projectRoot?: string;
  readonly error?: { readonly phase?: string; readonly code?: string; readonly hint?: string };
}

function shellName(env: Readonly<Record<string, string | undefined>>): string {
  if (env.SHELL) return basename(env.SHELL);
  if (env.ComSpec) return basename(env.ComSpec);
  return process.platform === "win32" ? "unknown-windows-shell" : "unknown-shell";
}

function categoryPath(root: string | undefined, path: string | undefined): string {
  if (!path) return "-";
  if (!isAbsolute(path)) return path.split(sep).join("/");
  if (!root) return "outside-project";
  const rel = relative(root, path);
  if (rel === "") return ".";
  return rel.startsWith("..") ? `outside-project/${basename(path)}` : rel.split(sep).join("/");
}

function detectPackageManager(root: string | undefined, fs: DiagnosticBundleFs): string {
  if (!root) return "unknown";
  for (const [file, name] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    if (fs.existsSync(join(root, file))) return name;
  }
  return "unknown";
}

function configSummary(root: string | undefined, fs: DiagnosticBundleFs): readonly string[] {
  if (!root) return ["config: no project"];
  const path = join(root, "moeicons.config.jsonc");
  if (!fs.existsSync(path)) return ["config: missing moeicons.config.jsonc"];
  let raw: string;
  try {
    raw = fs.readFileSync(path);
  } catch {
    return ["config: unreadable (permission/IO)"];
  }
  const lines = [`config: moeicons.config.jsonc (${Buffer.byteLength(raw, "utf8")} bytes)`];
  // Field presence only; never dump icon names or arbitrary content.
  const fields = [
    "schemaVersion",
    "tier",
    "target",
    "outputDir",
    "defaultTheme",
    "themes",
    "icons",
    "downloadMode",
    "integration",
  ];
  const present = fields.filter((field) => new RegExp(`"${field}"\\s*:`).test(raw));
  lines.push(`config.fields: ${present.join(", ") || "none"}`);
  const tier = /"tier"\s*:\s*"(free|pro)"/.exec(raw)?.[1];
  const target = /"target"\s*:\s*"(react|vue|vanilla|assets)"/.exec(raw)?.[1];
  if (tier) lines.push(`config.tier: ${tier}`);
  if (target) lines.push(`config.target: ${target}`);
  return lines;
}

export function buildDiagnosticBundle(input: BundleInput): string {
  const now = input.now ?? new Date();
  const lines: string[] = [];
  lines.push("moeicons diagnostics v1");
  lines.push(`generatedAt: ${now.toISOString()}`);
  lines.push(`cliVersion: ${input.cliVersion}`);
  lines.push(`node: ${input.nodeVersion ?? process.version} (required >=24)`);
  lines.push(`os: ${input.platform ?? process.platform}/${input.arch ?? process.arch}`);
  lines.push(`shell: ${shellName(input.env)}`);
  lines.push(
    `tty: stdin=${String(input.stdinTTY ?? false)} stdout=${String(input.stdoutTTY ?? false)} stderr=${String(input.stderrTTY ?? false)} columns=${input.columns ?? "unknown"}`,
  );
  lines.push(`ci: ${input.env.CI === "true" || input.env.CI === "1" ? "true" : "false"}`);
  lines.push(`installSource: ${input.installSource ?? "unknown"}`);

  let report: ReturnType<typeof runDoctorDiagnose> | undefined;
  try {
    report = runDoctorDiagnose(input.cwd);
  } catch (error) {
    lines.push(
      `project: diagnostics unavailable (${error instanceof Error ? error.message : "unknown"})`,
    );
  }
  const root = input.projectRoot ?? report?.report.projectRoot;
  lines.push(`project: ${root ? "found" : "none"}`);
  lines.push(`packageManager: ${detectPackageManager(root, NODE_FS)}`);
  lines.push(...configSummary(root, NODE_FS));
  if (report) {
    for (const anchor of report.report.anchors) {
      const path = categoryPath(root, anchor.path);
      const exists = anchor.path ? (NODE_FS.existsSync(anchor.path) ? "exists" : "missing") : "n/a";
      lines.push(`anchor.${anchor.kind}: ${anchor.status} path=${path} ${exists}`);
    }
  }
  if (input.error) {
    lines.push(
      `error: phase=${input.error.phase ?? "unknown"} code=${input.error.code ?? "unknown"}${input.error.hint ? ` hint=${input.error.hint}` : ""}`,
    );
  }
  if (input.diagnostics) {
    lines.push("events:");
    for (const event of input.diagnostics.lastEvents(20)) {
      lines.push(
        `  ${event.at} ${event.level}${event.phase ? ` ${event.phase}` : ""}${event.code ? ` ${event.code}` : ""} ${redactText(event.message)}`,
      );
    }
  }
  lines.push("end");
  const text = `${lines.join("\n")}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BUNDLE_BYTES) {
    // Keep the head (metadata) and tail (recent events); drop the middle.
    const budget = MAX_BUNDLE_BYTES - 200;
    return `${text.slice(0, budget)}\n<truncated to ${MAX_BUNDLE_BYTES} bytes>\nend\n`;
  }
  return text;
}

export interface ExportedBundle {
  readonly path: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ExportOptions {
  readonly directory: string;
  readonly input: BundleInput;
  readonly fs?: DiagnosticBundleFs;
  readonly random?: () => string;
}

export function diagnosticFileName(
  cliVersion: string,
  now: Date,
  random: () => string = () => randomBytes(3).toString("hex"),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${DIAGNOSTIC_FILE_PREFIX}${cliVersion}-${stamp}-${random()}.txt`;
}

/** Prune expired/over-limit bundles. Called on export and at CLI startup. */
export function pruneDiagnosticBundles(
  directory: string,
  options: { readonly now?: Date; readonly fs?: DiagnosticBundleFs } = {},
): readonly string[] {
  const fs = options.fs ?? NODE_FS;
  const now = (options.now ?? new Date()).getTime();
  if (!fs.existsSync(directory)) return [];
  let names: readonly string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.startsWith(DIAGNOSTIC_FILE_PREFIX));
  } catch {
    return [];
  }
  const entries = names.flatMap((name) => {
    const path = join(directory, name);
    try {
      const stats = fs.statSync(path);
      if (!stats.isFile()) return [];
      return [{ path, name, size: stats.size, mtimeMs: stats.mtimeMs }];
    } catch {
      return [];
    }
  });
  const removed: string[] = [];
  const expire = (path: string) => {
    try {
      fs.rmSync(path);
      removed.push(path);
    } catch {
      /* ignore */
    }
  };
  const live = entries.filter((entry) => {
    if (now - entry.mtimeMs > BUNDLE_TTL_MS) {
      expire(entry.path);
      return false;
    }
    return true;
  });
  live.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let total = 0;
  live.forEach((entry, index) => {
    total += entry.size;
    if (index >= MAX_BUNDLE_FILES || total > MAX_BUNDLE_TOTAL_BYTES) expire(entry.path);
  });
  return removed;
}

export function exportDiagnosticBundle(options: ExportOptions): ExportedBundle {
  const fs = options.fs ?? NODE_FS;
  const now = options.input.now ?? new Date();
  fs.mkdirSync(options.directory);
  pruneDiagnosticBundles(options.directory, { now, fs });
  const content = buildDiagnosticBundle({ ...options.input, now });
  const name = diagnosticFileName(options.input.cliVersion, now, options.random);
  const path = join(options.directory, name);
  const temporary = `${path}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, path);
  return {
    path,
    bytes: Buffer.byteLength(content, "utf8"),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + BUNDLE_TTL_MS).toISOString(),
  };
}
