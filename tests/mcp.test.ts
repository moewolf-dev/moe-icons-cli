import { describe, it, expect, vi } from "vitest";
import { createMcpServer, runMcpStdio } from "../src/mcp/server.js";

function makeDeps(overrides: Partial<Parameters<typeof createMcpServer>[0]> = {}) {
  const out: string[] = [];
  const services = {
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
