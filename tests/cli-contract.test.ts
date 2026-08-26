import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/commands/parser.js";
import { main } from "../src/cli.js";
import { CLI_ERROR_EXIT_MAP, type CliErrorCode } from "../src/errors/index.js";
import { MOEICONS_BANNER } from "../src/ui/banner.js";

function makeRuntime(cwd = "/non-existent-project") {
  const out: string[] = [];
  const err: string[] = [];
  return {
    runtime: {
      cwd: () => cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      env: {},
      isTTY: () => false,
      readLine: async () => "",
      readKey: async () => "",
    },
    out,
    err,
  };
}

describe("CLI parser compatibility contract", () => {
  it("keeps the current argv-to-command mapping stable", () => {
    expect(parseArgs([])).toEqual({
      command: { name: "wizard" },
      json: false,
      yes: false,
      noTailwind: false,
    });
    expect(parseArgs(["install", "free"])).toEqual({
      command: { name: "install", group: "free" },
      json: false,
      yes: false,
      noTailwind: false,
    });
    expect(parseArgs(["--help"])).toEqual({
      command: { name: "help" },
      json: false,
      yes: false,
      noTailwind: false,
    });
    expect(parseArgs(["-v", "--json"])).toEqual({
      command: { name: "version" },
      json: true,
      yes: false,
      noTailwind: false,
    });
    expect(parseArgs(["--pro"])).toEqual({
      command: { name: "install", group: "pro" },
      json: false,
      yes: false,
      noTailwind: false,
    });
    expect(parseArgs(["--ent", "--yes"])).toEqual({
      command: { name: "install", group: "ent" },
      json: false,
      yes: true,
      noTailwind: false,
    });
    expect(parseArgs(["generate", "--no-tailwind"])).toEqual({
      command: { name: "generate" },
      json: false,
      yes: false,
      noTailwind: true,
    });
  });
});

describe("CLI output compatibility contract", () => {
  it("returns the current help contract", async () => {
    const fixture = makeRuntime();
    const code = await main(["--help"], fixture.runtime);
    expect({
      code,
      stdout: fixture.out.join(""),
      stderr: fixture.err.join(""),
    }).toMatchInlineSnapshot(`
      {
        "code": 0,
        "stderr": "",
        "stdout": "moeicons — Moeicons icon library CLI

      Usage:
        moeicons                      interactive guided flow (free / pro / login)
        moeicons install [group]      install an icon group
        moeicons login                browser login (PKCE)
        moeicons logout               clear local session
        moeicons account              show account/tier info
        moeicons groups               list available icon groups
        moeicons generate             generate React/Vue proxy components
        moeicons init                 create moeicons.config.json
        moeicons mcp                  start the MCP stdio server
        moeicons --version            show version
        moeicons --help               show help

      Options:
        --json         machine-readable JSON output
        --yes          skip confirmations in noninteractive mode
  --target       output target: react, vue, vanilla, or assets
  --no-tailwind  skip Tailwind config auto-integration
      ",
      }
    `);
  });

  it("returns the current version contract in text and json modes", async () => {
    const text = makeRuntime();
    const json = makeRuntime();
    expect(await main(["--version"], text.runtime)).toBe(0);
    expect(await main(["--version", "--json"], json.runtime)).toBe(0);
    expect(text.out.join("")).toBe("0.0.1\n");
    expect(json.out.join("")).toBe('{"ok":true,"version":"0.0.1"}');
    expect(text.err).toEqual([]);
    expect(json.err).toEqual([]);
  });

  it("keeps the current json wizard fallback stable", async () => {
    const fixture = makeRuntime();
    const code = await main(["--json"], fixture.runtime);
    expect(code).toBe(0);
    expect(fixture.err).toEqual([]);
    expect(fixture.out.join("")).toBe(
      '{"ok":true,"message":"interactive wizard unavailable in JSON mode; use install/login/account/groups/generate"}',
    );
  });

  it("keeps the current failure contract for unsupported commands", async () => {
    const fixture = makeRuntime();
    const cases = [
      { argv: ["groups"], message: "groups is not implemented yet" },
      { argv: ["frobnicate"], message: "unknown command: frobnicate" },
      {
        argv: ["install"],
        message: "no package.json found in the current directory or parents; run inside a project",
      },
    ] as const;
    for (const testCase of cases) {
      const runtime = makeRuntime();
      const code = await main(testCase.argv, runtime.runtime);
      expect(code).toBe(1);
      expect(runtime.out).toEqual([]);
      expect(runtime.err.join("")).toContain(testCase.message);
    }
    expect(fixture.out).toEqual([]);
  });

  it("emits parseable --json success and failure bodies without banner or ANSI", async () => {
    const ansi = /\u001b\[/;
    const success = makeRuntime();
    expect(await main(["--version", "--json"], success.runtime)).toBe(0);
    const successBody = JSON.parse(success.out.join("")) as { ok: boolean; version: string };
    expect(successBody).toEqual({ ok: true, version: "0.0.1" });
    expect(success.err).toEqual([]);
    expect(success.out.join("")).not.toMatch(ansi);
    expect(success.out.join("")).not.toContain(MOEICONS_BANNER.trim());

    const failure = makeRuntime();
    expect(await main(["groups", "--json"], failure.runtime)).toBe(
      CLI_ERROR_EXIT_MAP.NOT_IMPLEMENTED,
    );
    expect(failure.err).toEqual([]);
    const failureBody = JSON.parse(failure.out.join("")) as {
      ok: boolean;
      code: string;
      message: string;
    };
    expect(failureBody).toEqual({
      ok: false,
      code: "NOT_IMPLEMENTED",
      message: "groups is not implemented yet",
    });
    expect(failure.out.join("")).not.toMatch(ansi);
    expect(failure.out.join("")).not.toContain(MOEICONS_BANNER.trim());
  });

  it("maps unknown command, NOT_IMPLEMENTED, NOT_TTY, and install-without-project to the frozen table", async () => {
    const jsonCases: { argv: string[]; code: CliErrorCode; message: string }[] = [
      {
        argv: ["frobnicate", "--json"],
        code: "VALIDATION_ERROR",
        message: "unknown command: frobnicate",
      },
      {
        argv: ["groups", "--json"],
        code: "NOT_IMPLEMENTED",
        message: "groups is not implemented yet",
      },
      { argv: ["install", "--json"], code: "VALIDATION_ERROR", message: "no package.json found" },
    ];

    for (const testCase of jsonCases) {
      const fixture = makeRuntime();
      const exit = await main(testCase.argv, fixture.runtime);
      expect(exit).toBe(CLI_ERROR_EXIT_MAP[testCase.code]);
      expect(fixture.err).toEqual([]);
      const body = JSON.parse(fixture.out.join("")) as {
        ok: false;
        code: CliErrorCode;
        message: string;
      };
      expect(body.ok).toBe(false);
      expect(body.code).toBe(testCase.code);
      expect(body.message).toContain(testCase.message);
    }

    const notTty = makeRuntime();
    expect(await main([], notTty.runtime)).toBe(CLI_ERROR_EXIT_MAP.NOT_TTY);
    expect(notTty.out).toEqual([]);
    expect(notTty.err.join("")).toContain("TTY");
  });

  it("keeps init and generate json error payloads stable when no project/config exists", async () => {
    const missingProject = makeRuntime();
    expect(await main(["init", "--json"], missingProject.runtime)).toBe(1);
    expect(missingProject.err).toEqual([]);
    expect(JSON.parse(missingProject.out.join(""))).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "no project found",
    });

    const dir = mkdtempSync(join(tmpdir(), "cli-contract-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0" }),
      );
      const missingConfig = makeRuntime(dir);
      expect(await main(["generate", "--json"], missingConfig.runtime)).toBe(1);
      expect(missingConfig.err).toEqual([]);
      expect(JSON.parse(missingConfig.out.join(""))).toEqual({
        ok: false,
        code: "VALIDATION_ERROR",
        message: "config state: missing",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns NOT_TTY for a non-TTY wizard without an explicit command and writes no files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-contract-notty-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0" }),
      );
      const before = readdirSync(dir).sort();
      const fixture = makeRuntime(dir);
      expect(await main([], fixture.runtime)).toBe(1);
      expect(fixture.out.join("")).not.toContain("{");
      expect(fixture.out.join("")).not.toContain(MOEICONS_BANNER.trim());
      expect(fixture.err.join("")).toContain("TTY");
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(existsSync(join(dir, "src"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
