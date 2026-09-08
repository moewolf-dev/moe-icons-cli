import { join, relative } from "node:path";
import type { AnchorResult } from "./types.js";
import {
  type DetectorIo,
  findPackageJsonDir,
  detectPackageManager,
  readJsonSafe,
  isRecord,
} from "./helpers.js";

export interface AdapterEvidence {
  readonly adapter: string | undefined;
  readonly candidateAdapters: readonly string[];
  readonly framework: "react" | "vue" | "vanilla" | "unknown";
}

/** Detect adapter/framework from package.json deps + key config files. */
export function detectAdapter(
  io: DetectorIo,
  root: string,
  pkg: Record<string, unknown>,
): AdapterEvidence {
  const deps = new Set([
    ...Object.keys(isRecord(pkg.dependencies) ? (pkg.dependencies as object) : {}),
    ...Object.keys(isRecord(pkg.devDependencies) ? (pkg.devDependencies as object) : {}),
  ]);
  const has = (name: string) => deps.has(name);
  const candidates: string[] = [];

  const hasNext = has("next");
  const hasNuxt = has("nuxt");
  const hasVue = has("vue");
  const hasReact = has("react") || has("react-dom");
  const hasVite = has("vite") || has("@vitejs/plugin-react") || has("@vitejs/plugin-vue");

  if (hasNext) {
    const app = io.existsSync(join(root, "app")) || io.existsSync(join(root, "src", "app"));
    candidates.push(app ? "next-app" : "next-pages");
  }
  if (hasNuxt) {
    candidates.push("nuxt");
  }
  if (hasVite && hasVue) candidates.push("vite-vue");
  if (hasVite && hasReact) candidates.push("vite-react");
  if (hasVue && !hasVite && !hasNuxt) candidates.push("nuxt"); // heuristic via plugin file below
  if (hasReact && !hasVite && !hasNext) candidates.push("vite-react");

  if (candidates.length === 0) {
    const hasVanillaEntry =
      io.existsSync(join(root, "src", "main.ts")) ||
      io.existsSync(join(root, "src", "main.js")) ||
      io.existsSync(join(root, "main.ts")) ||
      io.existsSync(join(root, "main.js"));
    if (hasVanillaEntry) {
      candidates.push("vanilla");
      return { adapter: "vanilla", candidateAdapters: ["vanilla"], framework: "vanilla" };
    }
    return { adapter: undefined, candidateAdapters: [], framework: "unknown" };
  }

  const unique = [...new Set(candidates)];
  const framework: AdapterEvidence["framework"] = hasVue
    ? "vue"
    : hasReact
      ? "react"
      : "unknown";
  return {
    adapter: unique.length === 1 ? unique[0] : undefined,
    candidateAdapters: unique,
    framework: unique.length === 1 ? framework : "unknown",
  };
}

export interface ManifestAnchorOptions {
  readonly cwd: string;
  readonly io: DetectorIo;
}

/**
 * Project manifest anchor (E2E-B2). Never writes. Locates the nearest
 * package.json, classifies package manager + workspace membership + adapter,
 * and returns candidates when the layout is ambiguous.
 */
export function inspectProjectManifest(options: ManifestAnchorOptions): AnchorResult {
  const { io } = options;
  const root = findPackageJsonDir(io, options.cwd);
  if (!root) {
    return {
      kind: "manifest",
      status: "missing",
      candidates: [],
      evidence: ["no package.json found in cwd or parents"],
      fixes: [],
    };
  }
  const pkg = readJsonSafe(io, join(root, "package.json"));
  if (!pkg) {
    return {
      kind: "manifest",
      status: "invalid",
      path: join(root, "package.json"),
      candidates: [],
      evidence: ["package.json exists but is not valid JSON"],
      fixes: [],
    };
  }
  const packageManager = detectPackageManager(io, root);
  const workspace = isRecord(pkg.workspaces)
    ? []
    : typeof pkg.workspaces === "string"
      ? [pkg.workspaces]
      : Array.isArray(pkg.workspaces)
        ? pkg.workspaces.filter((w): w is string => typeof w === "string")
        : [];
  const memberHint = workspace.length ? ` (workspace root, members: ${workspace.join(", ")})` : "";
  const adapterInfo = detectAdapter(io, root, pkg);
  const evidence = [
    `package.json: ${relative(options.cwd, join(root, "package.json")) || "package.json"}`,
    `packageManager: ${packageManager}${memberHint}`,
    adapterInfo.adapter
      ? `adapter: ${adapterInfo.adapter}`
      : adapterInfo.candidateAdapters.length > 0
        ? `adapter ambiguous: ${adapterInfo.candidateAdapters.join(", ")}`
        : "adapter: unknown",
  ];

  return {
    kind: "manifest",
    status: packageManager === "unknown" ? "ambiguous" : "ok",
    path: join(root, "package.json"),
    candidates: [],
    evidence,
    fixes: [],
  };
}
