import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AnchorResult, PlannedFileChange } from "./types.js";

/**
 * Read-only detector io. Detectors never write: they accept only read primitives
 * so a detector cannot be coerced into mutating a project.
 */
export interface DetectorIo {
  readonly existsSync: typeof existsSync;
  readonly readFileSync: (path: string) => string;
}

export const realDetectorIo: DetectorIo = {
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a JSON file safely; returns undefined on parse/io error. */
export function readJsonSafe(io: DetectorIo, file: string): Record<string, unknown> | undefined {
  if (!io.existsSync(file)) return undefined;
  try {
    const raw: unknown = JSON.parse(io.readFileSync(file));
    return isRecord(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Walk upward from startDir to the nearest directory containing package.json. */
export function findPackageJsonDir(io: DetectorIo, startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (io.existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Package manager precedence with ambiguity -> unknown (never guesses). */
export function detectPackageManager(io: DetectorIo, root: string): string {
  const pnpm = io.existsSync(join(root, "pnpm-lock.yaml"));
  const yarn = io.existsSync(join(root, "yarn.lock"));
  const npm = io.existsSync(join(root, "package-lock.json"));
  const present = [pnpm, yarn, npm].filter(Boolean).length;
  if (present > 1) return "unknown";
  if (pnpm) return "pnpm";
  if (yarn) return "yarn";
  if (npm) return "npm";
  return "unknown";
}

export function okResult(kind: AnchorResult["kind"], patch: Partial<AnchorResult>): AnchorResult {
  return { kind, status: "ok", candidates: [], evidence: [], fixes: [], ...patch };
}

export function createFileFix(path: string, content: string): PlannedFileChange {
  return { kind: "create", path, before: undefined, after: content };
}
