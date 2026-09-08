import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { diagnoseProject, type DiagnoseOutcome } from "../project/anchors/diagnose.js";
import { applyPlannedChanges } from "../project/anchors/apply.js";
import type { DiagnosticReport, PlannedFileChange } from "../project/anchors/types.js";

export type DoctorMode = "diagnose" | "check" | "dry-run" | "apply";

export interface DoctorResult {
  readonly mode: DoctorMode;
  readonly ok: true;
  readonly report: DiagnosticReport;
  readonly written?: readonly string[];
  readonly alreadyConfigured?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  missing: "MISSING",
  invalid: "INVALID",
  ambiguous: "AMBIGUOUS",
  unsupported: "UNSUPPORTED",
  "not-required": "N/A",
};

/** Read-only four-anchor diagnosis. Never writes. */
export function runDoctorDiagnose(cwd: string): DiagnoseOutcome {
  return diagnoseProject({ cwd });
}

/** Human-readable table (manifest + config always shown). */
export function formatDoctorReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  for (const anchor of report.anchors) {
    const label = STATUS_LABEL[anchor.status] ?? anchor.status.toUpperCase();
    const path = anchor.path
      ? report.projectRoot
        ? toPosixRelative(report.projectRoot, anchor.path)
        : anchor.path
      : "-";
    const name = anchorName(anchor.kind);
    lines.push(`${name.padEnd(22)} ${label.padEnd(10)} ${path}`);
    for (const evidence of anchor.evidence) lines.push(`  - ${evidence}`);
    if (anchor.fixes.length) {
      lines.push(`  fixes: ${anchor.fixes.map((f) => `${f.kind} ${f.path}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function anchorName(kind: DiagnosticReport["anchors"][number]["kind"]): string {
  switch (kind) {
    case "manifest":
      return "Project manifest";
    case "config":
      return "Moeicons config";
    case "application":
      return "Application integration";
    case "style":
      return "Styling integration";
  }
}

function toPosixRelative(root: string, path: string): string {
  if (!isAbsolute(path)) return path.split(sep).join("/");
  const rel = relative(root, path);
  if (!rel || rel === "") return ".";
  return rel.split(sep).join("/");
}

/** JSON-stable machine report. Paths are POSIX-relative to projectRoot (never absolute home). */
export function doctorJson(report: DiagnosticReport): Record<string, unknown> {
  const root = report.projectRoot;
  return {
    ok: report.anchors.every((a) => a.status === "ok" || a.status === "not-required"),
    ...(root ? { projectRoot: "." } : {}),
    anchors: report.anchors.map((a) => ({
      kind: a.kind,
      status: a.status,
      ...(a.path && root ? { path: toPosixRelative(root, a.path) } : a.path ? { path: a.path } : {}),
      candidates: root
        ? a.candidates.map((c) => toPosixRelative(root, c))
        : [...a.candidates],
      evidence: a.evidence,
      fixes: a.fixes.map((f) => ({
        kind: f.kind,
        path: f.path,
        ...(f.before !== undefined ? { before: f.before } : {}),
        after: f.after,
      })),
    })),
  };
}

/**
 * `moeicons doctor --check`: exit non-zero when any required anchor is not OK.
 * Required anchors are manifest/config/application; style is optional.
 */
export function checkRequiresFix(report: DiagnosticReport): boolean {
  const required: Array<DiagnosticReport["anchors"][number]["kind"]> = [
    "manifest",
    "config",
    "application",
  ];
  return report.anchors.some(
    (a) => required.includes(a.kind) && a.status !== "ok" && a.status !== "not-required",
  );
}

/** Build the complete init plan (config create + application + style fixes). */
export function buildInitPlan(cwd: string): { readonly outcome: DiagnoseOutcome } {
  return { outcome: diagnoseProject({ cwd }) };
}

/** Collect safe planned fixes from a diagnose outcome (already deduped). */
export function collectSafeFixes(outcome: DiagnoseOutcome): readonly PlannedFileChange[] {
  return outcome.fixes;
}

/** Human-readable unified-style diffs for a planned change set. */
export function formatPlannedDiffs(changes: readonly PlannedFileChange[]): string {
  if (changes.length === 0) return "";
  const blocks: string[] = [];
  for (const change of changes) {
    blocks.push(formatOneDiff(change));
  }
  return blocks.join("\n\n");
}

function formatOneDiff(change: PlannedFileChange): string {
  const path = change.path;
  if (change.kind === "create" || change.before === undefined) {
    const added = change.after.split("\n").map((line) => `+${line}`).join("\n");
    return `*** create ${path}\n--- /dev/null\n+++ b/${path}\n${added}`;
  }
  const beforeLines = change.before.split("\n");
  const afterLines = change.after.split("\n");
  const removed = beforeLines.map((line) => `-${line}`).join("\n");
  const added = afterLines.map((line) => `+${line}`).join("\n");
  return `*** replace ${path}\n--- a/${path}\n+++ b/${path}\n${removed}\n${added}`;
}

/** Machine-readable diffs for `--json --dry-run`. */
export function plannedDiffsJson(
  changes: readonly PlannedFileChange[],
): readonly Record<string, unknown>[] {
  return changes.map((change) => ({
    kind: change.kind,
    path: change.path,
    diff: formatOneDiff(change),
  }));
}

const FS = {
  existsSync: (path: string): boolean => existsSync(path),
  readTextFileSync: (path: string): string => readFileSync(path, "utf8"),
  mkdirSync: (path: string): void => {
    mkdirSync(path, { recursive: true });
  },
  writeTextFileSync: (path: string, content: string): void => {
    writeFileSync(path, content);
  },
  renameSync: (from: string, to: string): void => renameSync(from, to),
  rmSync: (path: string): void => {
    rmSync(path, { recursive: true, force: true });
  },
} as const;

function projectRootOf(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no project found");
    dir = parent;
  }
}

function emptyReport(projectRoot: string): DiagnosticReport {
  return { projectRoot, anchors: [] };
}

export interface DoctorApplyFailure {
  readonly ok: false;
  readonly message: string;
  readonly written: readonly string[];
}
export type DoctorApplyOutcome = DoctorResult | DoctorApplyFailure;

/**
 * Apply a confirmed safe plan (all anchors' fixes). Transactional; a second run
 * is a no-op (`alreadyConfigured`).
 */
export function runDoctorApply(
  cwd: string,
  fixes: readonly PlannedFileChange[],
): DoctorApplyOutcome {
  const root = projectRootOf(cwd);
  const outcome = applyPlannedChanges(root, fixes, FS);
  if (!outcome.ok) {
    return { ok: false, message: outcome.message, written: [] };
  }
  return {
    mode: "apply",
    ok: true,
    alreadyConfigured: outcome.alreadyConfigured,
    written: outcome.written,
    report: emptyReport(root),
  };
}
