import { join } from "node:path";
import type { AnchorResult, PlannedFileChange } from "./types.js";
import type { DetectorIo } from "./helpers.js";
import { parseSource } from "./parse.js";
import type { File } from "@babel/types";

export type { PlannedFileChange };

/**
 * Application anchor (E2E-B3).
 *
 * Only three auto-patchable shapes are supported and each gets its own
 * analyzer/plan in this file:
 *   - Vite React  `createRoot(...).render(<App />)`
 *   - Vite Vue    `createApp(App).mount(...)`
 *   - Vanilla     a single module entry
 * Next App/Pages, Nuxt and custom bootstrap are `unsupported` (detection +
 * manual instructions only, fixes empty). Detectors never write; they return a
 * plan of PlannedFileChange built from parsed AST positions.
 */

const ENTRY_CANDIDATES: Record<string, readonly string[]> = {
  "vite-react": ["src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.jsx"],
  "vite-vue": ["src/main.ts", "src/main.js"],
  vanilla: ["src/main.ts", "src/main.js", "main.ts", "main.js"],
  "next-app": ["app/layout.tsx", "src/app/layout.tsx"],
  "next-pages": ["pages/_app.tsx", "src/pages/_app.tsx"],
  nuxt: ["plugins/moeicons.ts", "app.vue"],
};

export interface ApplicationAnchorOptions {
  readonly root: string;
  readonly adapter?: string;
  readonly io: DetectorIo;
  /** true when the target is assets-only and application registration is not required. */
  readonly assetsOnly?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Returns true when the file imports the moeicons proxy at the given specifier. */
function hasImport(source: string, specifier: string): boolean {
  return new RegExp(`from\\s+['"]${escapeRegExp(specifier)}['"]`).test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the single `createRoot(...).render(...)` statement text region. */
function readEntry(
  io: DetectorIo,
  root: string,
  rel: string,
): { readonly source: string } | undefined {
  const full = join(root, rel);
  if (!io.existsSync(full)) return undefined;
  try {
    return { source: io.readFileSync(full) };
  } catch {
    return undefined;
  }
}

function locateCandidate(
  io: DetectorIo,
  root: string,
  candidates: readonly string[],
): { readonly rel: string; readonly source: string } | { readonly ambiguous: true } {
  const present = candidates.filter((c) => readEntry(io, root, c) !== undefined);
  if (present.length === 0) return { ambiguous: true };
  if (present.length > 1) return { ambiguous: true };
  return { rel: present[0] ?? "", source: readEntry(io, root, present[0] ?? "")?.source ?? "" };
}

function unsupportedManual(adapter: string): AnchorResult {
  return {
    kind: "application",
    status: "unsupported",
    candidates: ENTRY_CANDIDATES[adapter] ?? [],
    evidence: [
      `${adapter} registration is detect-only in this CLI release; a manual patch is required`,
    ],
    fixes: [],
  };
}
/**
 * Vite React plan: wrap the unique root in `MoeiconsProvider`. The plan is
 * generated from a parsed AST but applied as a small deterministic text patch so
 * it survives formatting differences.
 */
function planViteReact(source: string, rel: string): AnchorResult {
  if (hasImport(source, "./moeicons")) {
    return {
      kind: "application",
      status: "ok",
      path: rel,
      candidates: [rel],
      evidence: ["MoeiconsProvider already imported from the generated proxy"],
      fixes: [],
    };
  }
  const parsed = parseSource(source, rel);
  if (!parsed.ok) {
    return {
      kind: "application",
      status: "invalid",
      path: rel,
      candidates: [rel],
      evidence: [`cannot parse ${rel}: ${parsed.error}`],
      fixes: [],
    };
  }
  const root = findUniqueRender(parsed.ast);
  if (root === "multiple") {
    return {
      kind: "application",
      status: "ambiguous",
      path: rel,
      candidates: [rel],
      evidence: ["multiple createRoot(...).render(...) calls found"],
      fixes: [],
    };
  }
  if (root === undefined) {
    return {
      kind: "application",
      status: "unsupported",
      path: rel,
      candidates: [rel],
      evidence: ["no unique createRoot(...).render(<App />) shape found"],
      fixes: [],
    };
  }
  const { childStart, childEnd } = root;
  const child = source.slice(childStart, childEnd);
  const after =
    source.slice(0, childStart) + `<MoeiconsProvider>${child}</MoeiconsProvider>` + source.slice(childEnd);
  const imported = insertImport(after, `import { MoeiconsProvider } from "./moeicons";`);
  return {
    kind: "application",
    status: "missing",
    path: rel,
    candidates: [rel],
    evidence: ["unique createRoot render found; Provider wrap plan generated"],
    fixes: [{ kind: "replace", path: rel, before: source, after: imported }],
  };
}

/** Find the unique JSX child range of a `.render(...)` call. */
function findUniqueRender(ast: File):
  | { readonly childStart: number; readonly childEnd: number }
  | "multiple"
  | undefined {
  const renders: Array<{ start: number; end: number }> = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node) || typeof node !== "object") return;
    const type = typeof node.type === "string" ? node.type : "";
    if (
      type === "CallExpression" &&
      isRecord(node.callee) &&
      node.callee.type === "MemberExpression" &&
      isRecord(node.callee.object) &&
      node.callee.object.type === "CallExpression" &&
      isRecord(node.callee.object.callee) &&
      node.callee.object.callee.type === "Identifier" &&
      node.callee.object.callee.name === "createRoot" &&
      isRecord(node.callee.property) &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "render" &&
      Array.isArray(node.arguments) &&
      node.arguments.length === 1
    ) {
      const child = node.arguments[0] as { start?: number; end?: number } | undefined;
      if (child && typeof child.start === "number" && typeof child.end === "number") {
        renders.push({ start: child.start, end: child.end });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  if (renders.length === 0) return undefined;
  if (renders.length > 1) return "multiple";
  const only = renders[0];
  return only ? { childStart: only.start, childEnd: only.end } : undefined;
}

function insertImport(source: string, line: string): string {
  if (source.includes(line)) return source;
  const lines = source.split("\n");
  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) {
      anchor = i;
      break;
    }
  }
  lines.splice(anchor + 1, 0, line);
  return lines.join("\n");
}

/** Vite Vue plan: create a Provider host and use it as the app root (no app.use). */
function planViteVue(source: string, rel: string): AnchorResult {
  if (hasImport(source, "./moeicons")) {
    return {
      kind: "application",
      status: "ok",
      path: rel,
      candidates: [rel],
      evidence: ["MoeiconsProvider host already imported"],
      fixes: [],
    };
  }
  const parsed = parseSource(source, rel);
  if (!parsed.ok) {
    return {
      kind: "application",
      status: "invalid",
      path: rel,
      candidates: [rel],
      evidence: [`cannot parse ${rel}: ${parsed.error}`],
      fixes: [],
    };
  }
  const mount = findCreateAppMount(parsed.ast);
  if (mount === "multiple") {
    return {
      kind: "application",
      status: "ambiguous",
      path: rel,
      candidates: [rel],
      evidence: ["multiple createApp(...).mount(...) calls found"],
      fixes: [],
    };
  }
  if (mount === undefined) {
    return {
      kind: "application",
      status: "unsupported",
      path: rel,
      candidates: [rel],
      evidence: ["no unique createApp(...).mount(...) shape found"],
      fixes: [],
    };
  }
  const { rootStart, rootEnd } = mount;
  const rootText = source.slice(rootStart, rootEnd);
  // Host component renders the original root inside MoeiconsProvider.
  const after =
    source.slice(0, rootStart) +
    `h(MoeiconsProvider, null, { default: () => ${rootText} })` +
    source.slice(rootEnd);
  return {
    kind: "application",
    status: "missing",
    path: rel,
    candidates: [rel],
    evidence: ["unique createApp found; Provider-host plan generated (no app.use plugin)"],
    fixes: [
      {
        kind: "replace",
        path: rel,
        before: source,
        after: `${insertImport(after, `import { MoeiconsProvider } from "./moeicons";`)}
import { h } from "vue";`,
      },
    ],
  };
}

function findCreateAppMount(ast: File):
  | { readonly rootStart: number; readonly rootEnd: number }
  | "multiple"
  | undefined {
  const found: Array<{ start: number; end: number }> = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    const type = typeof node.type === "string" ? node.type : "";
    if (
      type === "CallExpression" &&
      isRecord(node.callee) &&
      node.callee.type === "CallExpression" &&
      isRecord(node.callee.callee) &&
      node.callee.callee.type === "Identifier" &&
      node.callee.callee.name === "createApp" &&
      Array.isArray(node.arguments) &&
      node.arguments.length >= 1
    ) {
      const root = node.arguments[0] as { start?: number; end?: number } | undefined;
      if (root && typeof root.start === "number" && typeof root.end === "number") {
        found.push({ start: root.start, end: root.end });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  if (found.length === 0) return undefined;
  if (found.length > 1) return "multiple";
  const only = found[0];
  return only ? { rootStart: only.start, rootEnd: only.end } : undefined;
}

function planVanilla(source: string, rel: string): AnchorResult {
  const parsed = parseSource(source, rel);
  if (!parsed.ok) {
    return {
      kind: "application",
      status: "invalid",
      path: rel,
      candidates: [rel],
      evidence: [`cannot parse ${rel}: ${parsed.error}`],
      fixes: [],
    };
  }
  if (/createMoeiconsRuntime|mountIcon/.test(source)) {
    return {
      kind: "application",
      status: "ok",
      path: rel,
      candidates: [rel],
      evidence: ["Vanilla runtime init is present"],
      fixes: [],
    };
  }
  return {
    kind: "application",
    status: "missing",
    path: rel,
    candidates: [rel],
    evidence: ["Vanilla module entry found; runtime init plan generated"],
    fixes: [
      {
        kind: "replace",
        path: rel,
        before: source,
        after: `${source}\nimport { createMoeiconsRuntime } from "./moeicons";\ncreateMoeiconsRuntime();\n`,
      },
    ],
  };
}

export function inspectApplicationAnchor(options: ApplicationAnchorOptions): AnchorResult {
  const { io, root, adapter, assetsOnly } = options;
  if (assetsOnly) {
    return {
      kind: "application",
      status: "not-required",
      candidates: [],
      evidence: ["assets-only target requires no application registration"],
      fixes: [],
    };
  }
  if (!adapter) {
    return {
      kind: "application",
      status: "unsupported",
      candidates: [],
      evidence: ["adapter is unknown; no application entry can be located"],
      fixes: [],
    };
  }
  if (adapter === "next-app" || adapter === "next-pages" || adapter === "nuxt") {
    return unsupportedManual(adapter);
  }
  const candidates = ENTRY_CANDIDATES[adapter] ?? [];
  const located = locateCandidate(io, root, candidates);
  if ("ambiguous" in located) {
    const present = candidates.filter((c) => readEntry(io, root, c) !== undefined);
    const path = present.length === 1 ? join(root, present[0] ?? "") : undefined;
    return {
      kind: "application",
      status: present.length === 0 ? "missing" : "ambiguous",
      ...(path !== undefined ? { path } : {}),
      candidates: present.length ? present : candidates,
      evidence: present.length
        ? [`multiple entry candidates: ${present.join(", ")}`]
        : [`no entry candidate found among: ${candidates.join(", ")}`],
      fixes: [],
    };
  }
  if (adapter === "vite-react") return planViteReact(located.source, located.rel);
  if (adapter === "vite-vue") return planViteVue(located.source, located.rel);
  if (adapter === "vanilla") return planVanilla(located.source, located.rel);
  return unsupportedManual(adapter);
}
