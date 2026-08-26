import { join } from "node:path";
import { createFileIfAbsent, type TransactionalFs } from "../project/install.js";
import { detectProject } from "../project/detect.js";
import { findConfigFile, renderMoeiconsConfigJsonc } from "../project/config.js";
import type { CommandContext } from "./context.js";
import type { Target } from "../commands/parser.js";

export type InitResult =
  | { readonly ok: true; readonly created: string }
  | {
      readonly ok: false;
      readonly reason: "no-project" | "exists" | "write-failed";
      readonly path?: string;
    };

export function runInitUseCase(
  context: CommandContext,
  fs_: TransactionalFs,
  target?: Target,
): InitResult {
  const project = detectProject(context.cwd);
  if (!project) return { ok: false, reason: "no-project" };
  if (findConfigFile(project.root)) return { ok: false, reason: "exists" };
  const configPath = join(project.root, "moeicons.config.jsonc");
  try {
    const created = createFileIfAbsent(
      configPath,
      renderMoeiconsConfigJsonc({
        target: target ?? (project.framework === "vue" ? "vue" : "react"),
      }),
      fs_,
    );
    return created
      ? { ok: true, created: configPath }
      : { ok: false, reason: "exists", path: configPath };
  } catch {
    return { ok: false, reason: "write-failed", path: configPath };
  }
}
