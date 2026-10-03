import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { createMcpServices, main, type CliRuntime } from "../src/cli.js";
import { createMcpServer } from "../src/mcp/server.js";
import { writeFreeReleaseFixture } from "./helpers/free-release-fixture.js";

describe("project MCP operations", () => {
  let root: string, runtime: CliRuntime;
  let call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "moeicons-mcp-project-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package-lock.json"), "{}");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3", react: "^18", vite: "^5" } }));
    writeFileSync(join(root, "src/main.ts"), "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app');\n");
    writeFileSync(join(root, "src/App.vue"), "<template><div>App</div></template>\n");
    runtime = { cwd: () => root, stdout() {}, stderr() {}, isTTY: () => false, env: {} };
    const services = createMcpServices(runtime);
    call = async (name, args = {}) => await services.callTool!(name, args) as Record<string, unknown>;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it("requires an explicit choice in mixed projects and honors Vue in CLI/MCP", async () => {
    expect(await call("init_config")).toMatchObject({ ok: false, code: "AMBIGUOUS_PROJECT" });
    let text = "";
    await main(["init", "--target", "vue", "--dry-run", "--json"], { ...runtime, stdout: (chunk) => { text += chunk; } });
    expect(text).toContain('\\"vue\\"');
    expect(await call("init_config", { target: "vue" })).toMatchObject({ ok: true });
    expect((parse(readFileSync(join(root, "moeicons.config.jsonc"), "utf8")) as { target: string }).target).toBe("vue");
  });
  it("preserves JSONC comments and prefix groups, supports deletion, and detects stale hashes", async () => {
    await call("init_config", { target: "vue" });
    const before = await call("get_project_config");
    expect(await call("update_config", { expectedHash: before.hash, patch: { icons: { add: ["dashboard"], remove: ["ui-search"] } } })).toMatchObject({ ok: true });
    const raw = readFileSync(join(root, "moeicons.config.jsonc"), "utf8");
    expect(raw).toContain("//");
    const cfg = parse(raw) as { icons: Record<string, string[]> };
    expect(cfg.icons.dashboard).toContain("dashboard"); expect(cfg.icons.ui).not.toContain("ui-search");
    expect(await call("update_config", { expectedHash: before.hash, patch: {} })).toMatchObject({ ok: false, code: "CONFIG_CHANGED" });
  });
  it("fails atomically and dry-run never writes", async () => {
    await call("init_config", { target: "vue" }); const before = await call("get_project_config");
    const path = join(root, "moeicons.config.jsonc"), raw = readFileSync(path, "utf8");
    expect(await call("update_config", { expectedHash: before.hash, patch: { defaultTheme: "missing" } })).toMatchObject({ ok: false });
    expect(await call("update_config", { expectedHash: before.hash, patch: { icons: { add: ["dashboard"] } }, dryRun: true })).toMatchObject({ ok: true });
    await expect(call("update_config", { expectedHash: before.hash, patch: { icons: { add: ["../escape"] } } })).rejects.toThrow("icon IDs");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
  it("allows bitmap bootstrap without claiming release availability", async () => {
    await call("init_config", { target: "vue" }); const cfg = await call("get_project_config");
    expect(await call("update_config", { expectedHash: cfg.hash, patch: { tier: "pro", themes: { upsert: { metal: { styleGroup: "moe-3d-metal", format: "webp", imageSize: 128 } } } } })).toMatchObject({ ok: true, availability: "unverified" });
  });
  it("rejects output symlink escapes and unknown fields", async () => {
    await call("init_config", { target: "vue" }); const before = await call("get_project_config");
    symlinkSync(tmpdir(), join(root, "escape"));
    await expect(call("update_config", { expectedHash: before.hash, patch: { outputDir: "escape/generated" } })).rejects.toThrow();
    await expect(call("update_config", { expectedHash: before.hash, patch: { surprise: 1 } })).rejects.toThrow("unknown");
  });
  it("executes real install/generate use cases and removes deleted owned proxies", async () => {
    const release = join(root, "release"); mkdirSync(release); writeFreeReleaseFixture(release, { useBundledCatalog: true });
    const services = createMcpServices({ ...runtime, env: { MOEICONS_FREE_RELEASE_DIR: release, MOEICONS_CACHE_DIR: join(root, "cache") } });
    const invoke = async (name: string, args: Record<string, unknown> = {}) => await services.callTool!(name, args) as Record<string, unknown>;
    await invoke("init_config", { target: "vue" });
    expect(await invoke("install", { tier: "free" })).toMatchObject({ ok: true });
    expect(await invoke("generate")).toMatchObject({ ok: true });
    const cfg = await invoke("get_project_config");
    expect(await invoke("update_config", { expectedHash: cfg.hash, patch: { icons: { remove: ["ui-search"] } } })).toMatchObject({ ok: true });
    expect(await invoke("install", { tier: "free" })).toMatchObject({ ok: true });
    expect(await invoke("generate")).toMatchObject({ ok: true });
    expect(existsSync(join(root, "src/moeicons/icons/UiSearch.ts"))).toBe(false);
  });
  it("handles notifications, malformed messages and tool errors", async () => {
    const server = createMcpServer({ services: createMcpServices(runtime), stdout() {}, stderr() {} });
    expect(await server.handle(null)).toMatchObject({ error: { code: -32600 } });
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "ping" })).toMatchObject({ result: {} });
    expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generate", arguments: [] } })).toMatchObject({ error: { code: -32602 } });
    expect(await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "generate" } })).toMatchObject({ result: { isError: true } });
  });
});
