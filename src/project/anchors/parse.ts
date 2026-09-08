import { parse, type ParserPlugin } from "@babel/parser";
import type { File } from "@babel/types";

/**
 * Parse TS/TSX/JS/JSX/Vue-main source with @babel/parser. Returns `undefined`
 * when the file cannot be parsed (syntax error / unknown syntax), never throws.
 * Recorded before adding as runtime dep: @babel/parser 7.29.8, MIT license,
 * ~1.9 MB unpacked, `npm audit --omit=dev` clean.
 */
export function parseSource(
  source: string,
  filePath: string,
): { readonly ok: true; readonly ast: File } | { readonly ok: false; readonly error: string } {
  const isTs = /\.tsx?$/i.test(filePath);
  const plugins: ParserPlugin[] = [];
  if (isTs) {
    plugins.push("typescript");
    if (/\.tsx$/i.test(filePath)) plugins.push("jsx");
  } else {
    plugins.push("jsx");
  }
  plugins.push(
    "decorators-legacy",
    "importAttributes",
    "explicitResourceManagement",
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "topLevelAwait",
  );
  try {
    const ast = parse(source, {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: false,
      plugins,
    });
    return { ok: true, ast };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
