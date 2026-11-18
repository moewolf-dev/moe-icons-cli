import { detectProject } from "../project/detect.js";
import { CliError } from "../errors/index.js";
import { promptConfirm, promptSelect, type CommandContext, type UiChoice } from "./context.js";

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
export const HOME_MESSAGE = "Choose an option";

export async function runWizardUseCase(
  context: CommandContext,
  options: {
    readonly json: boolean;
    readonly session?: WizardSessionState;
    readonly getLibraryStatus?: () => Promise<string>;
    readonly getProResourceLabel?: () => Promise<string | undefined>;
    /** W3-E2: optional single-line recent-task status shown above the menu. */
    readonly historyLine?: string;
  },
): Promise<WizardResult> {
  if (options.json) {
    return { ok: true, action: "json-hint", message: JSON_HINT };
  }

  const session = options.session ?? "signed-out";
  const proLabel =
    session === "authenticated" ? await options.getProResourceLabel?.().catch(() => undefined) : undefined;
  const message = options.historyLine ? `${options.historyLine}\n\n${HOME_MESSAGE}` : HOME_MESSAGE;
  const home = await promptSelect(context.ui, message, homeChoices(session, proLabel), context.signal);
  // Esc/Ctrl+C on home == Exit (cancel path); explicit Exit uses via=menu.
  if (home.kind !== "submit") return { ok: true, action: "exit", via: "cancel" };
  const choice = home.value;
  if (choice === "exit") return { ok: true, action: "exit", via: "menu" };

  if (choice === "login") return { ok: true, action: "pending", flow: "login" };
  if (choice === "pro-resources") return { ok: true, action: "pro-resources" };

  if (choice === "settings") {
    const setting = await promptSelect(context.ui, "Settings", settingsChoices(session), context.signal);
    if (setting.kind !== "submit" || setting.value === "back") return { ok: true, action: "back" };
    return { ok: true, action: "settings", flow: setting.value as "logout" | "cli-update" };
  }

  const project = detectProject(context.cwd);
  if (!project)
    throw new CliError(
      "VALIDATION_ERROR",
      "no package.json found in the current directory or parents; run inside a project",
    );

  if (choice === "manage") {
    const status = await options.getLibraryStatus?.();
    const management = await promptSelect(
      context.ui,
      "Manage project icons",
      manageChoices(status),
      context.signal,
    );
    if (management.kind !== "submit" || management.value === "back") return { ok: true, action: "back" };
    return { ok: true, action: "manage", flow: management.value as "reload" | "library-update" };
  }

  if (choice === "free" || choice === "pro") {
    const target = await promptSelect(
      context.ui,
      "Choose an output target",
      targetChoices(),
      context.signal,
    );
    // Esc/Back in a submenu returns to its parent (Home), per the frozen table.
    if (target.kind !== "submit" || target.value === "back") return { ok: true, action: "back" };
    const value = target.value;
    if (value !== "react" && value !== "vue" && value !== "vanilla" && value !== "assets") {
      return { ok: true, action: "back" };
    }
    const confirmed = await promptConfirm(
      context.ui,
      `Install ${choice} ${value} into ${project.root}?`,
      context.signal,
    );
    // Cancel on a destructive confirmation exits without writing; No returns Home.
    if (confirmed.kind !== "submit") return { ok: false, reason: "cancelled" };
    if (confirmed.value !== true) return { ok: true, action: "back" };
    return { ok: true, action: "install", group: choice, target: value };
  }

  throw new CliError("VALIDATION_ERROR", `unknown wizard choice: ${choice}`);
}
