import { describe, expect, it } from "vitest";
import { createMcpServices, type CliRuntime } from "../src/cli.js";

/**
 * AUD-CL-01: the MCP `install_icon_group` tool must fail closed with guidance
 * (never report a fake success) and must not contain a bare "(stub)".
 */
describe("MCP installIconGroup service", () => {
  it("fails closed with explicit guidance and no stub marker", async () => {
    const stderr: string[] = [];
    const runtime = {
      cwd: () => process.cwd(),
      stdout: () => undefined,
      stderr: (text: string) => stderr.push(text),
      env: {},
      isTTY: () => false,
    } as unknown as CliRuntime;
    const services = createMcpServices(runtime);
    const result = await services.installIconGroup({ groupId: "moe-outline", projectPath: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("single style-group install is not supported");
    expect(result.message).toContain('"moeicons install free"');
    expect(JSON.stringify({ result, stderr })).not.toContain("(stub)");
  });
});
