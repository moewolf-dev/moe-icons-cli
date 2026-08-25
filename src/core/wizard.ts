import { detectProject } from "../project/detect.js";
import { CliError } from "../errors/index.js";
import type { CommandContext } from "./context.js";

export type WizardResult =
  | { readonly ok: true; readonly action: "json-hint"; readonly message: string }
  | { readonly ok: true; readonly action: "install"; readonly group: "free" }
  | { readonly ok: true; readonly action: "pending"; readonly flow: "pro" | "login" }
  | { readonly ok: true; readonly action: "manage"; readonly flow: "reload" | "library-update" }
  | { readonly ok: true; readonly action: "settings"; readonly flow: "logout" | "cli-update" }
  | { readonly ok: false; readonly reason: "cancelled" };

const JSON_HINT =
  "interactive wizard unavailable in JSON mode; use install/login/account/groups/generate";

export type WizardSessionState = "authenticated" | "signed-out" | "unknown";

export function homeChoices(session: WizardSessionState) {
  return [
    { value: "free", label: "Install moeicons free" },
    { value: "pro", label: "Install moeicons pro" },
    { value: "manage", label: "Manage project icons" },
    ...(session === "authenticated" ? [] : [{ value: "login", label: session === "unknown" ? "Login (current status unknown)" : "Login" }]),
    { value: "settings", label: "Settings" },
  ] as const;
}

/** Wizard state machine. No Clack/Commander/process imports. */
export async function runWizardUseCase(
  context: CommandContext,
  options: { readonly json: boolean; readonly session?: WizardSessionState; readonly getLibraryStatus?: () => Promise<string> },
): Promise<WizardResult> {
  if (options.json) {
    return { ok: true, action: "json-hint", message: JSON_HINT };
  }

  const choice = await context.ui.select(
    "Choose an option",
    homeChoices(options.session ?? "signed-out"),
    context.signal,
  );
  if (choice === undefined) return { ok: false, reason: "cancelled" };

  if (choice === "login") return { ok: true, action: "pending", flow: "login" };
  if (choice === "settings") {
    const setting = await context.ui.select("Settings", [
      ...(options.session === "authenticated" ? [{ value: "logout", label: "Log out" }] : []),
      { value: "cli-update", label: "Check for CLI updates" },
    ], context.signal);
    return setting === undefined ? { ok: false, reason: "cancelled" } : { ok: true, action: "settings", flow: setting as "logout" | "cli-update" };
  }
  const project = detectProject(context.cwd);
  if (!project) throw new CliError("VALIDATION_ERROR", "no package.json found in the current directory or parents; run inside a project");
  if (choice === "manage") {
    const status = await options.getLibraryStatus?.();
    const management = await context.ui.select("Manage project icons", [
      { value: "reload", label: "Update project resources" },
      { value: "library-update", label: `Update icon library version${status ? ` — ${status}` : ""}` },
    ], context.signal);
    return management === undefined ? { ok: false, reason: "cancelled" } : { ok: true, action: "manage", flow: management as "reload" | "library-update" };
  }
  const confirmed = await context.ui.confirm(`Install into ${project.root}?`, context.signal);
  if (confirmed !== true) return { ok: false, reason: "cancelled" };
  if (choice === "free") return { ok: true, action: "install", group: "free" };
  if (choice === "pro") return { ok: true, action: "pending", flow: choice };
  throw new CliError("VALIDATION_ERROR", `unknown wizard choice: ${choice}`);
}
