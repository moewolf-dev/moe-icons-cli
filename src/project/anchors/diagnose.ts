import type { IconCatalog } from "../../catalog/catalog.js";
import { dirname } from "node:path";
import type { AnchorResult, DiagnosticReport, PlannedFileChange } from "./types.js";
import { realDetectorIo, type DetectorIo } from "./helpers.js";
import { inspectProjectManifest } from "./project-manifest.js";
import { inspectMoeiconsConfig } from "./moeicons-config.js";
import { inspectApplicationAnchor } from "./application.js";
import { inspectStyleAnchor } from "./style.js";
import { readMoeiconsConfig } from "../config.js";

/**
 * Four-anchor orchestrator (E2E-B2..B5). Runs the fixed probe order and returns
 * a stable DiagnosticReport. This function is read-only: it never writes. Callers
 * decide how to render or apply `fixes`.
 */

export interface DiagnoseOptions {
  readonly cwd: string;
  readonly sourceCatalog?: IconCatalog | undefined;
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
    const loaded = readMoeiconsConfig(root, options.sourceCatalog);
    const confirmed = loaded.kind === "ok" ? loaded.config.integration : undefined;
    const effectiveAdapter = options.confirmed?.adapter ?? confirmed?.adapter ?? adapter;
    const confirmedEntry = options.confirmed?.entry ?? confirmed?.entry;
    const confirmedStyle = options.confirmed?.style ?? confirmed?.style;
    const assetsOnly = effectiveAdapter === "assets-only" || loaded.kind === "ok" && loaded.config.target === "assets";
    config = inspectMoeiconsConfig({
      root,
      io,
      sourceCatalog: options.sourceCatalog,
      ...(effectiveAdapter && effectiveAdapter !== "assets-only" ? { adapter: effectiveAdapter } : {}),
      assetsOnly,
      ambiguous: manifest.evidence.some((line) => line.startsWith("adapter ambiguous:")),
    });
    application = inspectApplicationAnchor({
      root,
      io,
      ...(effectiveAdapter ? { adapter: effectiveAdapter } : {}),
      assetsOnly,
      ...(loaded.kind === "ok" ? { outputDir: loaded.config.outputDir } : {}),
      ...(confirmedEntry ? { confirmedEntry } : {}),
    });
    style = inspectStyleAnchor({
      root,
      io,
      assetsOnly,
      ...(confirmedStyle ? { confirmedStyle } : {}),
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
  const ok = report.anchors.every((anchor) => anchor.kind === "style" || anchor.status === "ok" || anchor.status === "not-required");
  return { ok, report, fixes };
}
