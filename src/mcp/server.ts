/** Local, newline-delimited MCP transport. Business failures are tool results. */
import { CLI_VERSION } from "../ui/banner.js";

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}
export interface McpServices {
  readonly listIconGroups: () => Promise<unknown>;
  readonly getAccount: () => Promise<unknown>;
  readonly installIconGroup: (args: { groupId: string; projectPath: string }) => Promise<{ ok: boolean; message: string }>;
  readonly tools?: readonly McpTool[];
  readonly callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
export interface McpDeps {
  readonly services: McpServices;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly projectRoot?: string;
}
interface Response {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}
export class McpArgumentError extends Error {}
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function safeMcpValue(value: unknown, projectRoot?: string): unknown {
  if (typeof value === "string") return (projectRoot ? value.split(projectRoot).join(".") : value).replace(/https?:\/\/[^\s"<>]+\?[^\s"<>]+/g, "[redacted URL]").replace(/(?:\/Users\/|\/home\/)[^/\s]+/g, "[home]");
  if (Array.isArray(value)) return value.map((entry) => safeMcpValue(entry, projectRoot));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(token|secret|authorization|signedurl|verifier)/i.test(key)).map(([key, entry]) => [key, safeMcpValue(entry, projectRoot)]));
}
const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const legacyTools: readonly McpTool[] = [
  { name: "list_icon_groups", description: "List available style groups and catalog identity", inputSchema: objectSchema() },
  { name: "get_account", description: "Read the current account and entitlement without credentials", inputSchema: objectSchema() },
  { name: "install_icon_group", description: "Deprecated: use configuration and install instead", inputSchema: objectSchema({ groupId: { type: "string" }, projectPath: { type: "string" } }, ["groupId", "projectPath"]) },
];
export function createMcpServer(deps: McpDeps) {
  const tools = deps.services.tools ?? legacyTools;
  const handle = async (value: unknown): Promise<Response | undefined> => {
    const id = isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") ? value.id : null;
    const error = (code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || (value.id !== undefined && id === null)) return error(-32600, "invalid request");
    if (value.id === undefined) return undefined; // Never respond to notifications.
    if (value.params !== undefined && !isRecord(value.params)) return error(-32602, "params must be an object");
    const params = value.params ?? {};
    if (value.method === "initialize") {
      const requested = params.protocolVersion;
      const supported = ["2024-11-05", "2025-03-26", "2025-06-18"];
      const protocolVersion = typeof requested === "string" && supported.includes(requested) ? requested : "2024-11-05";
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "moeicons", version: CLI_VERSION } } };
    }
    if (value.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (value.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
    if (value.method !== "tools/call") return error(-32601, `method not found: ${value.method}`);
    const name = params.name;
    if (typeof name !== "string" || !tools.some((tool) => tool.name === name)) return error(-32601, "unknown tool");
    if (params.arguments !== undefined && !isRecord(params.arguments)) return error(-32602, "arguments must be an object");
    const args = params.arguments ?? {};
    try {
      let result: unknown;
      if (deps.services.callTool) result = await deps.services.callTool(name, args);
      else if (name === "list_icon_groups") result = await deps.services.listIconGroups();
      else if (name === "get_account") result = await deps.services.getAccount() ?? "not logged in";
      else {
        if (typeof args.groupId !== "string" || !args.groupId || typeof args.projectPath !== "string" || !args.projectPath) throw new McpArgumentError("groupId and projectPath are required strings");
        if (args.projectPath.split(/[\\/]/).includes("..")) throw new McpArgumentError("projectPath must not contain path traversal");
        result = await deps.services.installIconGroup({ groupId: args.groupId, projectPath: args.projectPath });
      }
      const safe = safeMcpValue(result, deps.projectRoot);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof safe === "string" ? safe : JSON.stringify(safe) }], ...(isRecord(result) && result.ok === false ? { isError: true } : {}) } };
    } catch (cause) {
      if (cause instanceof McpArgumentError) return error(-32602, cause.message);
      const message = String(safeMcpValue(cause instanceof Error ? cause.message : String(cause), deps.projectRoot));
      deps.stderr(`mcp tool error: ${message}\n`);
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: isRecord(cause) && typeof cause.code === "string" ? cause.code : "TOOL_ERROR", message }) }] } };
    }
  };
  return { handle };
}
export async function runMcpStdio(deps: McpDeps & { lines: AsyncIterable<string> }): Promise<void> {
  const server = createMcpServer(deps);
  for await (const line of deps.lines) {
    if (deps.signal?.aborted) break;
    if (!line.trim()) continue;
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { deps.stdout(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); continue; }
    const response = await server.handle(message);
    if (response) deps.stdout(JSON.stringify(response) + "\n");
  }
}
