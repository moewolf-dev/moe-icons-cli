import { join } from "node:path";
import type { AnchorResult } from "./types.js";
import type { DetectorIo } from "./helpers.js";
import { findConfigFile, readMoeiconsConfig } from "../config.js";
import { renderMoeiconsConfigJsonc } from "../config.js";
import type { Target } from "../../commands/parser.js";

/** Supported target for a freshly created config from the manifest adapter. */
export function targetFromAdapter(adapter: string | undefined): Target {
  if (adapter === "vite-vue" || adapter === "nuxt") return "vue";
  if (adapter === "vite-react" || adapter === "next-app" || adapter === "next-pages")
    return "react";
  if (adapter === "vanilla") return "vanilla";
  return "react";
}

export interface ConfigAnchorOptions {
  readonly root: string;
  readonly io?: DetectorIo;
  readonly adapter?: string;
  /** true when only assets are consumed and app entry is not required. */
  readonly assetsOnly?: boolean;
}

/**
 * Moeicons config anchor (E2E-B2). Never writes. If the config is missing and
 * this is a writable project it builds a create-file plan using the canonical
 * renderer; an existing invalid file is reported and never overwritten.
 */
export function inspectMoeiconsConfig(options: ConfigAnchorOptions): AnchorResult {
  const configPath = findConfigFile(options.root);
  if (!configPath) {
    const target = options.assetsOnly ? "assets" : targetFromAdapter(options.adapter);
    const content = renderMoeiconsConfigJsonc({ target });
    return {
      kind: "config",
      status: "missing",
      path: join(options.root, "moeicons.config.jsonc"),
      candidates: [],
      evidence: ["no moeicons config found; a create plan is available"],
      fixes: [
        {
          kind: "create",
          path: "moeicons.config.jsonc",
          before: undefined,
          after: content,
        },
      ],
    };
  }

  const loaded = readMoeiconsConfig(options.root);
  if (loaded.kind === "ok") {
    return {
      kind: "config",
      status: "ok",
      path: configPath,
      candidates: [],
      evidence: [`config schema v${loaded.config.schemaVersion} valid`, ...loaded.warnings],
      fixes: [],
    };
  }
  if (loaded.kind === "unsupported") {
    return {
      kind: "config",
      status: "unsupported",
      path: configPath,
      candidates: [],
      evidence: [`config schema version ${loaded.version} is not supported`],
      fixes: [],
    };
  }
  if (loaded.kind === "invalid") {
    return {
      kind: "config",
      status: "invalid",
      path: configPath,
      candidates: [],
      evidence: [loaded.message],
      fixes: [],
    };
  }
  // loaded.kind === "missing" is impossible because findConfigFile found one.
  return {
    kind: "config",
    status: "invalid",
    path: configPath,
    candidates: [],
    evidence: ["config exists but could not be loaded"],
    fixes: [],
  };
}
