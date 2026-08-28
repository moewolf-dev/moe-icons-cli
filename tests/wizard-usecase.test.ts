import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homeChoices, runWizardUseCase } from "../src/core/wizard.js";
import type { CommandContext, CommandUi } from "../src/core/context.js";
import { CliError } from "../src/errors/index.js";

function selectSequence(values: Array<string | undefined>) {
  let index = 0;
  return async () => values[index++] ?? undefined;
}

function fakeUi(overrides: Partial<CommandUi> = {}): CommandUi {
  return {
    select: selectSequence(["free", "react"]),
    confirm: async () => true,
    text: async () => "",
    note() {
      return undefined;
    },
    progress() {
      return {
        stop() {
          return undefined;
        },
      };
    },
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
      context(
        dir,
        fakeUi({
          select: async () => {
            throw new Error("select must not run in json mode");
          },
        }),
      ),
      { json: true },
    );
    expect(result).toMatchObject({ ok: true, action: "json-hint" });
  });

  it("returns cancelled when select is cancelled", async () => {
    const result = await runWizardUseCase(context(dir, fakeUi({ select: async () => undefined })), {
      json: false,
    });
    expect(result).toEqual({ ok: false, reason: "cancelled" });
  });

  it("installs free after a confirmed selection", async () => {
    const result = await runWizardUseCase(context(dir, fakeUi()), { json: false });
    expect(result).toEqual({ ok: true, action: "install", group: "free", target: "react" });
  });

  it("returns cancelled when the target selection is cancelled", async () => {
    const result = await runWizardUseCase(
      context(dir, fakeUi({ select: selectSequence(["free", undefined]) })),
      { json: false },
    );
    expect(result).toEqual({ ok: false, reason: "cancelled" });
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
          ...context(
            dir,
            fakeUi({
              select: async (_m, _c, signal) => {
                if (signal.aborted) throw new CliError("CANCELLED", "cancelled");
                return "free";
              },
            }),
          ),
          signal: controller.signal,
        },
        { json: false },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("freezes signed-out, authenticated and unknown home menu order", () => {
    expect(homeChoices("signed-out").map((choice) => choice.value)).toEqual([
      "pro",
      "free",
      "manage",
      "login",
      "settings",
    ]);
    expect(homeChoices("authenticated").map((choice) => choice.value)).toEqual([
      "pro",
      "free",
      "manage",
      "settings",
    ]);
    expect(homeChoices("unknown").map((choice) => choice.value)).toEqual([
      "pro",
      "free",
      "manage",
      "login",
      "settings",
    ]);
    expect(homeChoices("unknown").find((choice) => choice.value === "login")?.label).toContain(
      "unknown",
    );
    expect(homeChoices("signed-out").length).toBeLessThanOrEqual(10);
    expect(homeChoices("authenticated", "Download Pro resources").length).toBeLessThanOrEqual(10);
  });

  it("shows management status in the update action and returns both management flows", async () => {
    const seen: string[][] = [];
    let selections: Array<string | undefined> = ["manage", "library-update"];
    const ui = fakeUi({
      select: async (_message, choices) => {
        seen.push(choices.map((choice) => choice.label));
        return selections.shift();
      },
    });
    await expect(
      runWizardUseCase(context(dir, ui), {
        json: false,
        getLibraryStatus: async () => "Current: 1.0.0 / Latest: 1.1.0 / Status: update available",
      }),
    ).resolves.toEqual({ ok: true, action: "manage", flow: "library-update" });
    expect(seen[1]?.[1]).toContain("Current: 1.0.0");
    selections = ["manage", "reload"];
    await expect(runWizardUseCase(context(dir, ui), { json: false })).resolves.toEqual({
      ok: true,
      action: "manage",
      flow: "reload",
    });
  });

  it("shows logout only for a verified authenticated session", async () => {
    const values: string[][] = [];
    const ui = fakeUi({
      select: async (_message, choices) => {
        values.push(choices.map((choice) => choice.value));
        return values.length === 1 ? "settings" : "cli-update";
      },
    });
    await runWizardUseCase(context(dir, ui), { json: false, session: "signed-out" });
    expect(values[1]).toEqual(["cli-update"]);
    values.length = 0;
    await runWizardUseCase(context(dir, ui), { json: false, session: "authenticated" });
    expect(values[1]).toEqual(["logout", "cli-update"]);
  });
});
