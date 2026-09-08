/**
 * Four-anchor project diagnosis types (E2E-B1, contract:
 * `docs/contracts/project-integration-v1.md`).
 *
 * These types are pure data: detectors only READ files and BUILD a plan. They
 * never emit ANSI, never prompt, and never write to disk. Writers/commands that
 * display or apply the plan live outside the detectors.
 */

export type AnchorKind = "manifest" | "config" | "application" | "style";

export type AnchorStatus =
  | "ok"
  | "missing"
  | "invalid"
  | "ambiguous"
  | "unsupported"
  | "not-required";

/** A single proposed file change (relative POSIX path under the project root). */
export interface PlannedFileChange {
  readonly kind: "create" | "replace";
  readonly path: string;
  /** Full previous content (for `replace`); undefined only for `create`. */
  readonly before: string | undefined;
  /** Full next content. */
  readonly after: string;
}

export interface AnchorResult {
  readonly kind: AnchorKind;
  readonly status: AnchorStatus;
  readonly path?: string;
  readonly candidates: readonly string[];
  readonly evidence: readonly string[];
  readonly fixes: readonly PlannedFileChange[];
}

/** The four anchors in a fixed order, for human and `--json` output. */
export interface DiagnosticReport {
  readonly projectRoot?: string;
  readonly anchors: readonly AnchorResult[];
}
