/**
 * Minimal MCP (Model Context Protocol) stdio server. Registers only v1 tools:
 * list_icon_groups, get_account, install_icon_group. Protocol data goes only
 * to stdout; logs go to stderr. Graceful shutdown on SIGINT/SIGTERM.
 */

interface McpRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface McpResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

export interface McpServices {
  readonly listIconGroups: () => Promise<readonly { id: string; displayName: string }[]>;
  readonly getAccount: () => Promise<{ accountId: string; tier: string } | undefined>;
  readonly installIconGroup: (args: {
    groupId: string;
    projectPath: string;
  }) => Promise<{ ok: boolean; message: string }>;
}

export interface McpDeps {
  readonly services: McpServices;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
}

function validateArgs(
  method: string,
  params: Record<string, unknown> | undefined,
  required: readonly string[],
): Record<string, string> | undefined {
  if (!params) {
    return undefined;
  }
  for (const key of required) {
    if (typeof params[key] !== "string" || params[key].length === 0) {
      return undefined;
    }
  }
  const out: Record<string, string> = {};
  for (const key of required) {
    out[key] = String(params[key]);
  }
  return out;
}

/**
 * Create an MCP server bound to injected streams. Returns a dispatcher that
 * handles one decoded JSON-RPC message.
 */
export function createMcpServer(deps: McpDeps) {
  const handle = async (message: McpRequest): Promise<McpResponse | undefined> => {
    if (message.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "invalid request" } };
    }

    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "moeicons", version: "0.1.0" },
          },
        };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "list_icon_groups",
                description: "List available icon groups",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "get_account",
                description: "Get the current account/tier",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "install_icon_group",
                description: "Install an icon group into a project",
                inputSchema: {
                  type: "object",
                  properties: {
                    groupId: { type: "string" },
                    projectPath: { type: "string" },
                  },
                  required: ["groupId", "projectPath"],
                },
              },
            ],
          },
        };
      case "tools/call": {
        const toolName = message.params?.name;
        const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
        try {
          if (toolName === "list_icon_groups") {
            const groups = await deps.services.listIconGroups();
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: JSON.stringify(groups) }] },
            };
          }
          if (toolName === "get_account") {
            const account = await deps.services.getAccount();
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [
                  { type: "text", text: account ? JSON.stringify(account) : "not logged in" },
                ],
              },
            };
          }
          if (toolName === "install_icon_group") {
            const validated = validateArgs(toolName, args, ["groupId", "projectPath"]);
            if (!validated) {
              return {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32602, message: "groupId and projectPath are required strings" },
              };
            }
            const projectPath = validated["projectPath"];
            const groupId = validated["groupId"];
            if (!projectPath || !groupId) {
              return {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32602, message: "groupId and projectPath are required strings" },
              };
            }
            if (projectPath.split(/[\\/]/).includes("..")) {
              return {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32602, message: "projectPath must not contain path traversal" },
              };
            }
            const result = await deps.services.installIconGroup({
              groupId,
              projectPath,
            });
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] },
            };
          }
          return {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `unknown tool: ${String(toolName)}` },
          };
        } catch (error) {
          deps.stderr(`mcp tool error: ${String(error)}\n`);
          return {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: String(error) },
          };
        }
      }
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } };
    }
  };

  return { handle };
}

/**
 * Read JSON-RPC messages from an async iterable of lines and write responses to
 * stdout. Used by the stdio transport.
 */
export async function runMcpStdio(
  deps: McpDeps & { lines: AsyncIterable<string> },
): Promise<void> {
  const server = createMcpServer(deps);
  for await (const line of deps.lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: McpRequest;
    try {
      message = JSON.parse(trimmed) as McpRequest;
    } catch {
      deps.stdout(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      continue;
    }
    const response = await server.handle(message);
    if (response) {
      deps.stdout(JSON.stringify(response) + "\n");
    }
  }
}
