import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWizardUseCase } from "../src/core/wizard.js";
import type { CommandContext, CommandUi } from "../src/core/context.js";
import { CliError } from "../src/errors/index.js";

function fakeUi(overrides: Partial<CommandUi> = {}): CommandUi {
  return {
    select: async () => "free",
    confirm: async () => true,
    text: async () => "",
    note() { return undefined; },
    progress() { return { stop() { return undefined; } }; },
    ...overrides,
  };
}

function context(cwd: string, ui: CommandUi): CommandContext {
  return {
    ui,
    cwd,
    env: {},
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

describe("runWizardUseCase", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-wizard-core-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the json hint without calling UI", async () => {
    const result = await runWizardUseCase(
      context(dir, fakeUi({
        select: async () => {
          throw new Error("select must not run in json mode");
        },
      })),
      { json: true },
    );
    expect(result).toMatchObject({ ok: true, action: "json-hint" });
  });

  it("returns cancelled when select is cancelled", async () => {
    const result = await runWizardUseCase(context(dir, fakeUi({ select: async () => undefined })), { json: false });
    expect(result).toEqual({ ok: false, reason: "cancelled" });
  });

  it("installs free after a confirmed selection", async () => {
    const result = await runWizardUseCase(context(dir, fakeUi()), { json: false });
    expect(result).toEqual({ ok: true, action: "install", group: "free" });
  });

  it("returns cancelled when confirm is declined", async () => {
    const result = await runWizardUseCase(
      context(dir, fakeUi({ confirm: async () => undefined })),
      { json: false },
    );
    expect(result).toEqual({ ok: false, reason: "cancelled" });
  });

  it("surfaces abort via CANCELLED when select rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWizardUseCase(
        {
          ...context(dir, fakeUi({
            select: async (_m, _c, signal) => {
              if (signal.aborted) throw new CliError("CANCELLED", "cancelled");
              return "free";
            },
          })),
          signal: controller.signal,
        },
        { json: false },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
