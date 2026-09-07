import { detectProject } from "../project/detect.js";
import { CliError } from "../errors/index.js";
import type { CommandContext, UiChoice } from "./context.js";

export type WizardResult =
  | { readonly ok: true; readonly action: "json-hint"; readonly message: string }
  | {
      readonly ok: true;
      readonly action: "install";
      readonly group: "free" | "pro";
      readonly target: "react" | "vue" | "vanilla" | "assets";
    }
  | { readonly ok: true; readonly action: "pending"; readonly flow: "login" }
  | { readonly ok: true; readonly action: "pro-resources" }
  | { readonly ok: true; readonly action: "manage"; readonly flow: "reload" | "library-update" }
  | { readonly ok: true; readonly action: "settings"; readonly flow: "logout" | "cli-update" }
  | { readonly ok: true; readonly action: "back" }
  | { readonly ok: true; readonly action: "exit"; readonly via: "menu" | "cancel" }
  | { readonly ok: false; readonly reason: "cancelled" };

const JSON_HINT =
  "interactive wizard unavailable in JSON mode; use install/login/account/groups/generate";

export type WizardSessionState = "authenticated" | "signed-out" | "unknown";

const BACK: UiChoice = { value: "back", label: "Back", separatorBefore: true };
const EXIT: UiChoice = { value: "exit", label: "Exit" };

export function homeChoices(session: WizardSessionState, proResourcesLabel?: string): UiChoice[] {
  return [
    { value: "pro", label: "Install moeicons pro" },
    { value: "free", label: "Install moeicons free" },
    ...(session === "authenticated" && proResourcesLabel
      ? [{ value: "pro-resources", label: proResourcesLabel }]
      : []),
    { value: "manage", label: "Manage project icons" },
    ...(session === "authenticated"
      ? []
      : [
          {
            value: "login",
            label: session === "unknown" ? "Login (current status unknown)" : "Login",
          },
        ]),
    { value: "settings", label: "Settings" },
    EXIT,
  ];
}

export function settingsChoices(session: WizardSessionState): UiChoice[] {
  return [
    ...(session === "authenticated" ? [{ value: "logout", label: "Log out" }] : []),
    { value: "cli-update", label: "Check for CLI updates" },
    BACK,
  ];
}

export function manageChoices(status?: string): UiChoice[] {
  return [
    { value: "reload", label: "Update project resources" },
    {
      value: "library-update",
      label: `Update icon library version${status ? ` — ${status}` : ""}`,
    },
    BACK,
  ];
}

export function targetChoices(): UiChoice[] {
  return [
    { value: "react", label: "React" },
    { value: "vue", label: "Vue" },
    { value: "vanilla", label: "Vanilla" },
    { value: "assets", label: "Static assets" },
    BACK,
  ];
}

export function loginRecoveryChoices(): UiChoice[] {
  return [
    { value: "retry", label: "Retry login" },
    BACK,
  ];
}

/** Wizard state machine. No Clack/Commander/process imports. */
export async function runWizardUseCase(
  context: CommandContext,
  options: {
    readonly json: boolean;
    readonly session?: WizardSessionState;
    readonly getLibraryStatus?: () => Promise<string>;
    readonly getProResourceLabel?: () => Promise<string | undefined>;
  },
): Promise<WizardResult> {
  if (options.json) {
    return { ok: true, action: "json-hint", message: JSON_HINT };
  }

  const session = options.session ?? "signed-out";
  const proLabel =
    session === "authenticated" ? await options.getProResourceLabel?.().catch(() => undefined) : undefined;
  const choice = await context.ui.select("Choose an option", homeChoices(session, proLabel), context.signal);
  // Esc on home == Exit (cancel path); explicit Exit menu item uses via=menu.
  if (choice === undefined) return { ok: true, action: "exit", via: "cancel" };
  if (choice === "exit") return { ok: true, action: "exit", via: "menu" };

  if (choice === "login") return { ok: true, action: "pending", flow: "login" };
  if (choice === "pro-resources") return { ok: true, action: "pro-resources" };

  if (choice === "settings") {
    const setting = await context.ui.select("Settings", settingsChoices(session), context.signal);
    if (setting === undefined || setting === "back") return { ok: true, action: "back" };
    return { ok: true, action: "settings", flow: setting as "logout" | "cli-update" };
  }

  const project = detectProject(context.cwd);
  if (!project)
    throw new CliError(
      "VALIDATION_ERROR",
      "no package.json found in the current directory or parents; run inside a project",
    );

  if (choice === "manage") {
    const status = await options.getLibraryStatus?.();
    const management = await context.ui.select(
      "Manage project icons",
      manageChoices(status),
      context.signal,
    );
    if (management === undefined || management === "back") return { ok: true, action: "back" };
    return { ok: true, action: "manage", flow: management as "reload" | "library-update" };
  }

  if (choice === "free" || choice === "pro") {
    const target = await context.ui.select("Choose an output target", targetChoices(), context.signal);
    if (target === undefined || target === "back") return { ok: true, action: "back" };
    if (target !== "react" && target !== "vue" && target !== "vanilla" && target !== "assets") {
      return { ok: true, action: "back" };
    }
    const confirmed = await context.ui.confirm(
      `Install ${choice} ${target} into ${project.root}?`,
      context.signal,
    );
    // Esc / Ctrl+C on confirm exits; No returns to home (back)
    if (confirmed === undefined) return { ok: false, reason: "cancelled" };
    if (confirmed !== true) return { ok: true, action: "back" };
    return { ok: true, action: "install", group: choice, target };
  }

  throw new CliError("VALIDATION_ERROR", `unknown wizard choice: ${choice}`);
}
