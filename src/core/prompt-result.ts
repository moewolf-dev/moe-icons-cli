/**
 * REF-01 / P1-04: the canonical outcome of one interactive prompt.
 *
 * Adapters translate their native cancel symbol into exactly one of these four
 * outcomes, so the wizard never has to infer whether `undefined` meant Back,
 * Esc, Ctrl+C, EOF or an external abort. Business modules receive data, not
 * terminal concepts.
 */

export type PromptResult<T> =
  | { readonly kind: "submit"; readonly value: T }
  | { readonly kind: "back" }
  | { readonly kind: "cancel" }
  | { readonly kind: "abort" };

export function submitted<T>(value: T): PromptResult<T> {
  return { kind: "submit", value };
}

export const PROMPT_BACK: PromptResult<never> = { kind: "back" };
export const PROMPT_CANCEL: PromptResult<never> = { kind: "cancel" };
export const PROMPT_ABORT: PromptResult<never> = { kind: "abort" };

export function isSubmitted<T>(result: PromptResult<T>): result is { kind: "submit"; value: T } {
  return result.kind === "submit";
}

/** True when the user left the current step without submitting a value. */
export function isPromptExit(result: PromptResult<unknown>): boolean {
  return result.kind !== "submit";
}

/**
 * Legacy adapter bridge: the historical `T | undefined` contract cannot tell
 * Back from Abort. Only use this in code that has no navigation meaning (e.g.
 * a single optional confirmation), never to implement a submenu.
 */
export function toLegacyValue<T>(result: PromptResult<T>): T | undefined {
  return result.kind === "submit" ? result.value : undefined;
}
