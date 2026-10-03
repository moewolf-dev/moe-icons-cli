import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, basename } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import type { CliRuntime } from "../cli.js";
import { catalog } from "../catalog/catalog.js";
import { loadInstalledCatalogState } from "../core/generate.js";
import { buildInitPlan, collectSafeFixes, doctorJson, runDoctorApply, runDoctorDiagnose } from "../core/doctor.js";
import { findConfigFile, loadConfigDocument, validateConfigDocument } from "../project/config.js";
import { safeManagedPath } from "../project/install.js";
import { sha256Bytes } from "../project/install-metadata.js";
import { allowLocalTestFromEnv } from "../core/local-test-env.js";
import { toProxyName } from "../core/icon-names.js";
import type { Target } from "../commands/parser.js";
import { McpArgumentError, isRecord, type McpTool, type McpServices } from "./server.js";

const string = { type: "string" };
const strings = { type: "array", items: string, uniqueItems: true };
const boolean = { type: "boolean" };
const targetSchema = { type: "string", enum: ["vue", "react", "vanilla", "assets"] };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): McpTool => ({ name, description, inputSchema: { type: "object", properties: { projectPath: string, ...properties }, required, additionalProperties: false } });
export const projectTools = [
  tool("list_icon_groups", "Read style groups from verified installed catalog, or identify bundled fallback"),
  tool("get_account", "Read account/entitlement. Login outside MCP with moeicons login"),
  tool("get_project_config", "Read normalized configuration, hash for update_config, and integration diagnosis"),
  tool("find_icons", "Search icon IDs available in every requested style group", { query: string, styleGroups: strings, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: string }),
  tool("get_usage_guide", "Read generated-component integration rules", { target: targetSchema }),
  tool("init_config", "Initialize configuration and safe integration fixes. Explicit target resolves mixed frameworks", { target: targetSchema, integration: { type: "object", properties: { adapter: string, entry: string, style: string }, additionalProperties: false }, dryRun: boolean }),
  tool("update_config", "Patch JSONC without overwriting unrelated settings. Reinstall then generate after changing icons", { expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, patch: { type: "object", properties: { tier: { enum: ["free", "pro"] }, target: targetSchema, outputDir: string, defaultTheme: string, downloadMode: { enum: ["auto", "icons", "full"] }, missingIconPolicy: { enum: ["error", "fallback"] }, integration: { type: "object" }, themes: { type: "object", properties: { upsert: { type: "object" }, remove: strings }, additionalProperties: false }, icons: { type: "object", properties: { add: strings, remove: strings }, additionalProperties: false }, themeIcons: { type: "object" } }, additionalProperties: false }, dryRun: boolean }, ["expectedHash", "patch"]),
  tool("install", "Download and verify configured resources from Free/Pro release", { tier: { type: "string", enum: ["free", "pro"] } }, ["tier"]),
  tool("update", "Update resource release and reconcile config (not CLI self-update)"),
  tool("generate", "Generate code using installed verified resources; does not implicitly download"),
  tool("install_icon_group", "Deprecated. Configure style groups then call install", { groupId: string }, ["groupId", "projectPath"]),
] as const;

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new McpArgumentError("unknown argument field");
}
function list(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x) || new Set(value).size !== value.length) throw new McpArgumentError("expected unique string array");
  return value as string[];
}
function changes(value: unknown): { add: string[]; remove: string[] } {
  if (!isRecord(value)) throw new McpArgumentError("icon changes must be an object");
  keys(value, ["add", "remove"]);
  const add = list(value.add), remove = list(value.remove);
  if ([...add, ...remove].some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new McpArgumentError("icon IDs must be lowercase kebab-case");
  if (add.some((x) => remove.includes(x))) throw new McpArgumentError("cannot add and remove the same icon");
  return { add, remove };
}
const fail = (code: string, message: string) => ({ ok: false, code, message });
export function createProjectMcpServices(runtime: CliRuntime, execute: (argv: readonly string[]) => Promise<unknown>): McpServices {
  const root = () => realpathSync(runtime.cwd());
  function source() {
    const state = loadInstalledCatalogState(root(), { readFileSync, existsSync }, { allowLocalTest: allowLocalTestFromEnv(runtime.env) });
    if (state.status === "invalid") throw new Error(state.message);
    return { catalog: state.status === "ok" ? state.catalog : catalog, source: state.status === "ok" ? "installed" : "bundled" };
  }
  function loaded() {
    const path = findConfigFile(root());
    if (!path) throw new Error("configuration missing; call init_config first");
    safeManagedPath(root(), relative(root(), path));
    const state = source();
    const config = validateConfigDocument(loadConfigDocument(root()), state.catalog, { lenientCatalog: state.source === "bundled" });
    if (config.kind !== "ok") throw new Error(config.kind === "invalid" ? config.message : `configuration ${config.kind}`);
    safeManagedPath(root(), config.config.outputDir);
    return { ...state, path, config: config.config, raw: readFileSync(path, "utf8") };
  }
  const installIconGroup = () => Promise.resolve({ ok: false, message: 'single style-group install is not supported — run "moeicons install free" or "moeicons install pro"' });
  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (["init_config", "update_config", "install", "update", "generate"].includes(name) && !existsSync(resolve(root(), "package.json"))) throw new Error("bind MCP cwd to the project root containing package.json");
    const def = projectTools.find((entry) => entry.name === name);
    if (!def) throw new McpArgumentError("unknown tool");
    keys(args, Object.keys(def.inputSchema.properties as Record<string, unknown>));
    if (args.projectPath !== undefined && (typeof args.projectPath !== "string" || realpathSync(resolve(root(), args.projectPath)) !== root())) throw new McpArgumentError("projectPath must resolve to the bound project root");
    for (const key of ["dryRun"]) if (args[key] !== undefined && typeof args[key] !== "boolean") throw new McpArgumentError(`${key} must be boolean`);
    if (args.target !== undefined && !["react", "vue", "vanilla", "assets"].includes(String(args.target))) throw new McpArgumentError("invalid target");
    if (name === "install_icon_group") {
      if (typeof args.groupId !== "string" || typeof args.projectPath !== "string") throw new McpArgumentError("groupId and projectPath are required strings");
      return installIconGroup();
    }
    if (name === "list_icon_groups") { const s = source(); return { ok: true, source: s.source, catalogVersion: s.catalog.catalogVersion, sourceVersion: s.catalog.sourceVersion, groups: s.catalog.styleGroups }; }
    if (name === "get_account") {
      const result = await execute(["account", "--json"]);
      if (!isRecord(result) || result.ok === false) return result;
      const account = isRecord(result.account) ? result.account : {};
      return { ok: true, environment: result.environment, account: Object.fromEntries(["accountId", "tier", "entitlementStatus", "expiresAt"].filter((key) => account[key] !== undefined).map((key) => [key, account[key]])) };
    }
    if (name === "get_project_config") {
      const s = loaded();
      return { ok: true, path: basename(s.path), config: s.config, hash: sha256Bytes(s.raw), availability: s.source === "installed" ? "verified" : "unverified", doctor: doctorJson(runDoctorDiagnose(root(), s.catalog).report) };
    }
    if (name === "find_icons") {
      if (args.query !== undefined && typeof args.query !== "string") throw new McpArgumentError("query must be a string");
      const groups = list(args.styleGroups), s = source();
      if (groups.some((id) => !s.catalog.styleGroups.some((g) => g.id === id))) return fail("UNAVAILABLE_GROUP", "requested style group is absent from this catalog");
      const limit = args.limit ?? 30;
      const cursor = args.cursor ?? "0";
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100 || typeof cursor !== "string" || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new McpArgumentError("invalid limit/cursor");
      const query = String(args.query ?? "").toLowerCase();
      const items = s.catalog.icons.filter((icon) => groups.every((id) => icon.availableIn.includes(id)) && `${icon.id} ${icon.label} ${(icon.keywords ?? []).join(" ")}`.toLowerCase().includes(query));
      const offset = Number(cursor);
      return { ok: true, source: s.source, catalogVersion: s.catalog.catalogVersion, items: items.slice(offset, offset + limit).map((icon) => ({ id: icon.id, exportName: toProxyName(icon.id), availableIn: icon.availableIn })), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
    }
    if (name === "get_usage_guide") return { ok: true, target: args.target ?? "vue", guide: "Run init_config, read config/hash, find icons, update_config, install, then generate. Changing selections requires reinstall/update before generation. Install the generated runtime dependencies clsx and tailwind-merge (use a Tailwind-compatible version), as documented in the manual. Never edit generated files. Import named icon proxies from the generated index. Vue: wrap the application including navigation/footer in MoeiconsProvider and bind theme to an exact configured key; import components explicitly. React: wrap with MoeiconsProvider. Vanilla: use createMoeiconsRuntime and generated create functions. Assets: consume the generated assets. Inspect index.ts and installed MANUAL for exact exports. Decorative icons: aria-hidden and empty alt; icon-only controls need an accessible label. Never embed CLI credentials in browser code.", manual: existsSync(resolve(root(), ".moeicons/MANUAL.md")) ? ".moeicons/MANUAL.md" : null };
    if (name === "init_config") {
      let confirmed: { adapter?: string; entry?: string; style?: string } | undefined;
      if (args.integration !== undefined) {
        if (!isRecord(args.integration)) throw new McpArgumentError("integration must be an object");
        keys(args.integration, ["adapter", "entry", "style"]);
        for (const [key, value] of Object.entries(args.integration)) {
          if (typeof value !== "string" || !value) throw new McpArgumentError("integration fields must be strings");
          if (key !== "adapter") safeManagedPath(root(), value);
          else if (!["vite-vue", "vite-react", "next-app", "next-pages", "nuxt", "vanilla", "assets-only"].includes(value)) throw new McpArgumentError("invalid adapter");
        }
        confirmed = args.integration as typeof confirmed;
      }
      if (args.target && confirmed?.adapter) {
        const adapterTarget = confirmed.adapter === "vite-vue" || confirmed.adapter === "nuxt" ? "vue" : confirmed.adapter === "vanilla" ? "vanilla" : confirmed.adapter === "assets-only" ? "assets" : "react";
        if (args.target !== adapterTarget) throw new McpArgumentError("target and integration.adapter disagree");
      }
      const { outcome } = buildInitPlan(root(), args.target as Target | undefined, confirmed, source().catalog);
      if (outcome.report.anchors.some((anchor) => anchor.status === "ambiguous" || anchor.kind === "manifest" && anchor.status !== "ok")) return fail("AMBIGUOUS_PROJECT", "select target/integration before initialization");
      const fixes = collectSafeFixes(outcome);
      if (args.dryRun) return { ok: true, diffs: fixes, doctor: doctorJson(outcome.report) };
      return runDoctorApply(root(), fixes);
    }
    if (name === "update_config") {
      if (typeof args.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedHash) || !isRecord(args.patch)) throw new McpArgumentError("expectedHash and patch are required");
      const s = loaded();
      if (sha256Bytes(s.raw) !== args.expectedHash) return fail("CONFIG_CHANGED", "configuration changed; read it again before retrying");
      const patch = args.patch;
      keys(patch, ["tier", "target", "outputDir", "defaultTheme", "downloadMode", "missingIconPolicy", "integration", "themes", "icons", "themeIcons"]);
      let text = s.raw;
      const set = (path: (string | number)[], value: unknown) => { text = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })); };
      for (const [key, value] of Object.entries(patch)) if (!["themes", "icons", "themeIcons"].includes(key)) set([key], value);
      if (patch.integration !== undefined) set(["schemaVersion"], 3);
      if (patch.themes !== undefined) {
        if (!isRecord(patch.themes)) throw new McpArgumentError("themes must be an object");
        keys(patch.themes, ["upsert", "remove"]);
        const remove = list(patch.themes.remove), upsert = patch.themes.upsert ?? {};
        if (!isRecord(upsert) || remove.some((id) => id in upsert)) throw new McpArgumentError("invalid theme changes");
        for (const key of remove) set(["themes", key], undefined);
        for (const [key, value] of Object.entries(upsert)) set(["themes", key], value);
      }
      if (patch.icons !== undefined) {
        const delta = changes(patch.icons), doc = parse(text) as Record<string, unknown>;
        if (Array.isArray(doc.icons)) set(["icons"], [...new Set([...list(doc.icons).filter((id) => !delta.remove.includes(id)), ...delta.add])]);
        else if (isRecord(doc.icons)) {
          for (const [prefix, ids] of Object.entries(doc.icons)) set(["icons", prefix], list(ids).filter((id) => !delta.remove.includes(id)));
          for (const id of delta.add) {
            const prefix = s.catalog.icons.find((icon) => icon.id === id)?.prefix ?? id.split("-")[0]!;
            const current = parse(text) as { icons: Record<string, unknown> };
            set(["icons", prefix], [...new Set([...list(current.icons[prefix]), id])]);
          }
        } else throw new McpArgumentError("unsupported icons structure");
      }
      if (patch.themeIcons !== undefined) {
        if (!isRecord(patch.themeIcons)) throw new McpArgumentError("themeIcons must be an object");
        for (const [key, value] of Object.entries(patch.themeIcons)) {
          const doc = parse(text) as { themes: Record<string, Record<string, unknown>> };
          if (!doc.themes[key]) throw new McpArgumentError("unknown theme");
          const delta = changes(value);
          set(["themes", key, "icons"], [...new Set([...list(doc.themes[key].icons).filter((id) => !delta.remove.includes(id)), ...delta.add])]);
        }
      }
      const validated = validateConfigDocument({ kind: "ok", value: parse(text), version: s.config.schemaVersion === 3 || patch.integration ? 3 : 2 }, s.catalog, { lenientCatalog: s.source === "bundled" });
      if (validated.kind !== "ok") return fail("INVALID_CONFIG", validated.kind === "invalid" ? validated.message : validated.kind);
      safeManagedPath(root(), validated.config.outputDir);
      const diffs = [{ kind: "replace" as const, path: basename(s.path), before: s.raw, after: text }];
      if (args.dryRun) return { ok: true, diffs, requiresInstall: true, requiresGenerate: true };
      const applied = runDoctorApply(root(), diffs);
      return { ...applied, hash: sha256Bytes(text), availability: s.source === "installed" ? "verified" : "unverified", requiresInstall: true, requiresGenerate: true };
    }
    const s = loaded();
    if (name === "install") {
      if (args.tier !== "free" && args.tier !== "pro") throw new McpArgumentError("tier must be free or pro");
      if (args.tier !== s.config.tier) return fail("TIER_MISMATCH", "install tier must match configuration");
      return execute(["install", args.tier, "--yes", "--json"]);
    }
    return execute([name, "--yes", "--json"]);
  };
  return { tools: projectTools, callTool, listIconGroups: () => callTool("list_icon_groups", {}), getAccount: () => callTool("get_account", {}), installIconGroup };
}
