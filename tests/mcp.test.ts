import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpServer, runMcpStdio, type McpServices } from "../src/mcp/server.js";

function makeDeps(
  overrides: Partial<Omit<Parameters<typeof createMcpServer>[0], "services">> & {
    services?: Partial<McpServices>;
  } = {},
) {
  const out: string[] = [];
  const services: McpServices = {
    listIconGroups: async () => [{ id: "free", displayName: "Free" }],
    getAccount: async () => ({ accountId: "acc-1", tier: "pro" }),
    installIconGroup: async () => ({ ok: true, message: "installed" }),
    ...(overrides.services ?? {}),
  };
  return {
    deps: {
      services,
      stdout: (text: string) => out.push(text),
      stderr: () => undefined,
      ...overrides,
    } as Parameters<typeof createMcpServer>[0],
    out,
    services,
  };
}

describe("createMcpServer", () => {
  it("handles initialize with protocol info", async () => {
    const { deps } = makeDeps();
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(response?.result).toMatchObject({ protocolVersion: "2024-11-05" });
  });

  it("lists only the three v1 tools", async () => {
    const { deps } = makeDeps();
    const server = createMcpServer(deps);
    const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (response?.result as { tools: { name: string }[] })?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual([
      "list_icon_groups",
      "get_account",
      "install_icon_group",
    ]);
  });

  it("calls list_icon_groups", async () => {
    const { deps } = makeDeps();
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_icon_groups", arguments: {} },
    });
    const text = (response?.result as { content: { text: string }[] })?.content?.[0]?.text;
    expect(text).toContain("free");
  });

  it("rejects install with missing args", async () => {
    const { deps } = makeDeps();
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "install_icon_group", arguments: {} },
    });
    expect(response?.error?.code).toBe(-32602);
  });

  it("rejects path traversal in install", async () => {
    const { deps } = makeDeps();
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "install_icon_group",
        arguments: { groupId: "free", projectPath: "../escape" },
      },
    });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("traversal");
  });

  it("returns method-not-found for unknown tools", async () => {
    const { deps } = makeDeps();
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "delete_all", arguments: {} },
    });
    expect(response?.error?.code).toBe(-32601);
  });

  it("reports not logged in when the account service returns no session (offline/unauthenticated)", async () => {
    const { deps } = makeDeps({ services: { getAccount: async () => undefined } });
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_account", arguments: {} },
    });
    const text = (response?.result as { content: { text: string }[] })?.content?.[0]?.text;
    expect(text).toBe("not logged in");
  });

  it("propagates a forbidden entitlement error from the install service", async () => {
    const { deps } = makeDeps({
      services: {
        installIconGroup: async () => ({
          ok: false,
          message: "forbidden: group requires pro entitlement",
        }),
      },
    });
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "install_icon_group",
        arguments: { groupId: "pro-only", projectPath: "src/moeicons" },
      },
    });
    const text = (response?.result as { content: { text: string }[] })?.content?.[0]?.text;
    expect(text).toContain("forbidden");
    expect(text).toContain("pro entitlement");
  });

  it("propagates an expired/revoked token error without leaking the token", async () => {
    const log: string[] = [];
    const deps = {
      services: {
        listIconGroups: async () => [],
        getAccount: async () => undefined,
        installIconGroup: async () => {
          throw new Error("session expired: access token invalid");
        },
      },
      stdout: () => undefined,
      stderr: (text: string) => log.push(text),
    };
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "install_icon_group",
        arguments: { groupId: "free", projectPath: "src/moeicons" },
      },
    });
    expect(response?.error?.code).toBe(-32000);
    expect(response?.error?.message).toContain("session expired");
    // error goes to the log channel, never to the protocol result payload
    expect(response?.result).toBeUndefined();
    expect(log.join("\n")).toContain("session expired");
  });

  it("returns a structured error when the service is offline (network)", async () => {
    const { deps } = makeDeps({
      services: {
        listIconGroups: async () => {
          throw new Error("network offline");
        },
      },
    });
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "list_icon_groups", arguments: {} },
    });
    expect(response?.error?.code).toBe(-32000);
    expect(response?.error?.message).toContain("network offline");
  });
});

describe("CLI-15 disposable-project install via MCP", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-install-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mcp-fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs an allowed group into a disposable project through the service", async () => {
    const installed: { groupId: string; projectPath: string }[] = [];
    const deps = {
      services: {
        listIconGroups: async () => [{ id: "free", displayName: "Free icons" }],
        getAccount: async () => ({ accountId: "acc-1", tier: "free" }),
        installIconGroup: async (args: { groupId: string; projectPath: string }) => {
          installed.push(args);
          // emulate a real transactional install into the disposable root
          const { createInstallPlan, executeInstallPlan } = await import("../src/project/install.js");
          const plan = createInstallPlan(join(args.projectPath, "src", "moeicons"), {
            "types.ts": "export type {};",
            ".moeicons-free.marker": "free",
          });
          executeInstallPlan(plan, { mkdirSync, writeFileSync, existsSync, renameSync, rmSync });
          return { ok: true, message: `installed ${args.groupId}` };
        },
      },
      stdout: () => undefined,
      stderr: () => undefined,
    };
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "install_icon_group",
        arguments: { groupId: "free", projectPath: join(dir, "sub") },
      },
    });
    expect(installed).toEqual([{ groupId: "free", projectPath: join(dir, "sub") }]);
    const text = (response?.result as { content: { text: string }[] })?.content?.[0]?.text;
    expect(text).toContain('"ok":true');
    expect(existsSync(join(dir, "sub", "src", "moeicons", ".moeicons-free.marker"))).toBe(true);
  });

  it("rejects a project path that escapes the workspace root", async () => {
    const deps = {
      services: {
        listIconGroups: async () => [],
        getAccount: async () => undefined,
        installIconGroup: async () => ({ ok: true, message: "" }),
      },
      stdout: () => undefined,
      stderr: () => undefined,
    };
    const server = createMcpServer(deps);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "install_icon_group",
        arguments: { groupId: "free", projectPath: `${dir}/../escape` },
      },
    });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("traversal");
  });
});

describe("runMcpStdio", () => {
  it("writes responses only to stdout and logs to stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const lines = (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
      yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    })();
    const services = {
      listIconGroups: async () => [],
      getAccount: async () => undefined,
      installIconGroup: async () => ({ ok: true, message: "" }),
    };
    await runMcpStdio({
      services,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      lines,
    });
    expect(out.length).toBe(2);
    expect(err.length).toBe(0);
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0]?.result?.serverInfo?.name).toBe("moeicons");
  });

  it("emits parse errors for malformed JSON without crashing", async () => {
    const out: string[] = [];
    const lines = (async function* () {
      yield "{not json";
    })();
    await runMcpStdio({
      services: {
        listIconGroups: async () => [],
        getAccount: async () => undefined,
        installIconGroup: async () => ({ ok: true, message: "" }),
      },
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      lines,
    });
    const parsed = JSON.parse(out[0] ?? "");
    expect(parsed.error?.code).toBe(-32700);
  });
});
