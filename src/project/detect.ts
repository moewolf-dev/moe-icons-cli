import { existsSync, readFileSync } from "node:fs";
import { join, dirname, parse } from "node:path";

/**
 * Project/workspace/package-manager detection. Detection never writes and never
 * guesses; ambiguous cases are errors that require selection.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "unknown";

export interface DetectedProject {
  /** Absolute path to the directory containing package.json. */
  readonly root: string;
  readonly packageManager: PackageManager;
  /** Workspace members if this root declares workspaces. */
  readonly workspaceMembers: readonly string[];
  readonly framework: "react" | "vue" | "unknown";
}

/** Walk upward from startDir to find the nearest package.json. */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readJsonSafe(file: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Detect the package manager by lockfile precedence: pnpm-lock.yaml, then
 * yarn.lock, then package-lock.json. Conflicting lockfiles are an error.
 */
export function detectPackageManager(root: string): PackageManager {
  const hasPnpm = existsSync(join(root, "pnpm-lock.yaml"));
  const hasYarn = existsSync(join(root, "yarn.lock"));
  const hasNpm = existsSync(join(root, "package-lock.json"));

  const present = [hasPnpm, hasYarn, hasNpm].filter(Boolean).length;
  if (present > 1) {
    // conflict: caller must ask the user to choose, never guess
    return "unknown";
  }
  if (hasPnpm) return "pnpm";
  if (hasYarn) return "yarn";
  if (hasNpm) return "npm";
  return "unknown";
}

/** Read npm/pnpm workspace declarations. */
export function detectWorkspace(root: string): readonly string[] {
  const packageJson = readJsonSafe(join(root, "package.json"));
  if (packageJson) {
    const workspaces = packageJson.workspaces;
    if (typeof workspaces === "string") return [workspaces];
    if (Array.isArray(workspaces)) {
      return workspaces.filter((w): w is string => typeof w === "string");
    }
  }
  if (existsSync(join(root, "pnpm-workspace.yaml"))) {
    const content = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#") && l.length > 0);
    const packages = lines
      .filter((l) => !l.startsWith("packages:"))
      .map((l) => l.replace(/^\s*-\s*/, "").replace(/["']/g, "").trim())
      .filter((l) => l.length > 0);
    return packages;
  }
  return [];
}

/** Detect project at startDir, returning root + workspace members. */
export function detectProject(startDir: string): DetectedProject | undefined {
  const root = findProjectRoot(startDir);
  if (!root) return undefined;
  const packageManager = detectPackageManager(root);
  const workspaceMembers = detectWorkspace(root);
  const pkg = readJsonSafe(join(root, "package.json"));
  const dependencyNames = new Set([
    ...Object.keys((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...Object.keys((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}),
  ]);
  const hasReact = dependencyNames.has("react");
  const hasVue = dependencyNames.has("vue");
  const framework = hasReact === hasVue ? "unknown" : hasVue ? "vue" : "react";
  return { root, packageManager, workspaceMembers, framework };
}

/** Confirm a target is inside a selected workspace and not node_modules. */
export function assertWritableProject(
  root: string,
  target: string,
  workspaceMembers: readonly string[],
): string[] {
  const errors: string[] = [];
  if (target.split(/[\\/]/).includes("node_modules")) {
    errors.push("target must not be inside node_modules");
  }
  if (workspaceMembers.length > 0) {
    const resolvedRoot = parse(root).root;
    const inside = workspaceMembers.some(
      (member) => target.startsWith(join(root, member)) || target === root,
    );
    if (!inside) {
      errors.push(`target is outside the selected workspace at ${resolvedRoot}`);
    }
  }
  return errors;
}
