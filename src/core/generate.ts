import { executeGeneratedFiles, type TransactionalFs } from "../project/install.js";
import { detectProject } from "../project/detect.js";
import { readMoeiconsConfig } from "../project/config.js";
import { planGeneratedFiles } from "../generator/generate.js";
import type { CommandContext } from "./context.js";

export type GenerateResult =
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly errors?: readonly string[] };

export function runGenerateUseCase(context: CommandContext, fs_: TransactionalFs): GenerateResult {
  const project = detectProject(context.cwd);
  if (!project) return { ok: false, reason: "no-project" };
  const loaded = readMoeiconsConfig(project.root);
  if (loaded.kind !== "ok") return { ok: false, reason: `config state: ${loaded.kind}` };
  const plan = planGeneratedFiles(loaded.config, loaded.config.outputDir);
  if (!plan.ok) return { ok: false, reason: "validation", errors: plan.errors };
  try {
    executeGeneratedFiles(plan.files, project.root, loaded.config.outputDir, fs_);
    return { ok: true, files: plan.files.map((file) => file.path) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
