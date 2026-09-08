import { dirname } from "node:path";
import type { AnchorResult, DiagnosticReport, PlannedFileChange } from "./types.js";
import { realDetectorIo, type DetectorIo } from "./helpers.js";
import { inspectProjectManifest } from "./project-manifest.js";
import { inspectMoeiconsConfig } from "./moeicons-config.js";
import { inspectApplicationAnchor } from "./application.js";
import { inspectStyleAnchor } from "./style.js";

/**
 * Four-anchor orchestrator (E2E-B2..B5). Runs the fixed probe order and returns
 * a stable DiagnosticReport. This function is read-only: it never writes. Callers
 * decide how to render or apply `fixes`.
 */

export interface DiagnoseOptions {
  readonly cwd: string;
  readonly io?: DetectorIo;
  /** Confirmed config integration paths, when previously stored in config. */
  readonly confirmed?: { readonly adapter?: string; readonly entry?: string; readonly style?: string };
}

export interface DiagnoseOutcome {
  readonly ok: boolean;
  readonly report: DiagnosticReport;
  /** Combined, deduplicated, ordered fixes across anchors. */
  readonly fixes: readonly PlannedFileChange[];
}

export function diagnoseProject(options: DiagnoseOptions): DiagnoseOutcome {
  const io = options.io ?? realDetectorIo;
  const manifest = inspectProjectManifest({ cwd: options.cwd, io });
  const adapterLine = manifest.evidence.find((line) => line.startsWith("adapter: "));
  const rawAdapter = adapterLine ? adapterLine.slice("adapter: ".length) : undefined;
  const adapter =
    rawAdapter && rawAdapter !== "unknown" && !rawAdapter.startsWith("ambiguous")
      ? rawAdapter
      : undefined;

  let config: AnchorResult;
  let application: AnchorResult;
  let style: AnchorResult;
  if (manifest.status === "missing" || manifest.status === "invalid") {
    config = {
      kind: "config",
      status: "not-required",
      candidates: [],
      evidence: ["no writable project manifest; config anchor not evaluated"],
      fixes: [],
    };
    application = {
      kind: "application",
      status: "not-required",
      candidates: [],
      evidence: ["no writable project manifest; application anchor not evaluated"],
      fixes: [],
    };
    style = {
      kind: "style",
      status: "not-required",
      candidates: [],
      evidence: ["no writable project manifest; style anchor not evaluated"],
      fixes: [],
    };
  } else {
    const root = manifest.path ? dirname(manifest.path) : options.cwd;
    const assetsOnly = adapter === "assets-only";
    config = inspectMoeiconsConfig({
      root,
      io,
      ...(adapter && adapter !== "assets-only" ? { adapter } : {}),
      assetsOnly,
    });
    application = inspectApplicationAnchor({
      root,
      io,
      ...(adapter ? { adapter } : {}),
      assetsOnly,
    });
    style = inspectStyleAnchor({
      root,
      io,
      assetsOnly,
      ...(options.confirmed?.style ? { confirmedStyle: options.confirmed.style } : {}),
    });
  }

  const report: DiagnosticReport = {
    ...(manifest.status === "ok" && manifest.path ? { projectRoot: dirname(manifest.path) } : {}),
    anchors: [manifest, config, application, style],
  };
  const seen = new Set<string>();
  const fixes: PlannedFileChange[] = [];
  for (const anchor of report.anchors) {
    for (const fix of anchor.fixes) {
      const key = `${fix.kind}:${fix.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fixes.push(fix);
    }
  }
  const ok = report.anchors.every((anchor) => anchor.status === "ok" || anchor.status === "not-required");
  return { ok, report, fixes };
}
