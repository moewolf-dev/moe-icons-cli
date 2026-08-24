import { detectProject } from "../project/detect.js";
import { CliError } from "../errors/index.js";
import type { CommandContext } from "./context.js";

export type WizardResult =
  | { readonly ok: true; readonly action: "json-hint"; readonly message: string }
  | { readonly ok: true; readonly action: "install"; readonly group: "free" }
  | { readonly ok: true; readonly action: "pending"; readonly flow: "pro" | "login" }
  | { readonly ok: false; readonly reason: "cancelled" };

const JSON_HINT =
  "interactive wizard unavailable in JSON mode; use install/login/account/groups/generate";

/** Wizard state machine. No Clack/Commander/process imports. */
export async function runWizardUseCase(
  context: CommandContext,
  options: { readonly json: boolean },
): Promise<WizardResult> {
  if (options.json) {
    return { ok: true, action: "json-hint", message: JSON_HINT };
  }

  const choice = await context.ui.select(
    "Choose an option",
    [
      { value: "free", label: "Install moeicons free" },
      { value: "pro", label: "Install moeicons pro (API key)" },
      { value: "login", label: "Login" },
    ],
    context.signal,
  );
  if (choice === undefined) return { ok: false, reason: "cancelled" };

  const project = detectProject(context.cwd);
  if (!project) {
    throw new CliError(
      "VALIDATION_ERROR",
      "no package.json found in the current directory or parents; run inside a project",
    );
  }

  const confirmed = await context.ui.confirm(`Install into ${project.root}?`, context.signal);
  if (confirmed !== true) return { ok: false, reason: "cancelled" };

  if (choice === "free") return { ok: true, action: "install", group: "free" };
  if (choice === "pro" || choice === "login") return { ok: true, action: "pending", flow: choice };
  throw new CliError("VALIDATION_ERROR", `unknown wizard choice: ${choice}`);
}
