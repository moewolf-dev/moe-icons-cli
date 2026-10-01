import { createRequire } from "node:module";

export type SvgNode = { readonly name: string; readonly attrs: readonly [string, string][]; readonly children: readonly SvgNode[]; readonly text?: never } | { readonly text: string };
interface SvgModel {
  viewBox: string;
  rootAttrs: readonly [string, string][];
  children: readonly SvgNode[];
}
const shared = createRequire(import.meta.url)("./shared/svg-model.cjs") as {
  prepareSvg: (source: string, strategy: string) => SvgModel;
  rootPaintAttributes: (attrs: readonly [string, string][], strategy: string) => Map<string, string>;
};
export const prepareSvg = shared.prepareSvg;
export const rootPaintAttributes = shared.rootPaintAttributes;
