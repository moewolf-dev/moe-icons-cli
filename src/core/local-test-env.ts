import { resolveProDescriptorEndpoint } from "./pro-download.js";
import { resolveVersionsEndpoint } from "./version-service.js";

/**
 * A-1b (DEC-A1): a strictly gated seam that lets the packed CLI consume a
 * declared local-test candidate (`X.Y.Z-test`, channel `local-test`,
 * `publishable: false`) through the Pro flow, without touching the production
 * version parsers. `allowLocalTest` is true only when ALL hold:
 *   - MOEICONS_ENV=local
 *   - the resolved versions endpoint is loopback HTTP
 *   - the resolved Pro descriptor endpoint is loopback HTTP
 * Any other combination fails closed, so a production endpoint returning
 * `X.Y.Z-test` is still rejected.
 */
export const LOCAL_TEST_ENV_VALUE = "local";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function resolveLocalTestContext(
  env: Readonly<Record<string, string | undefined>>,
): { readonly allowLocalTest: boolean } {
  if (env.MOEICONS_ENV !== LOCAL_TEST_ENV_VALUE) return { allowLocalTest: false };
  if (!isLoopbackHttpUrl(resolveVersionsEndpoint(env))) return { allowLocalTest: false };
  if (!resolveProDescriptorEndpoint(env).allowLoopback) return { allowLocalTest: false };
  return { allowLocalTest: true };
}

/**
 * Read-side local-test context for an already-installed project. The Pro network
 * seam above is strict; parsing a *local* install metadata file may also be a
 * Free fixture install driven by `MOEICONS_FREE_RELEASE_DIR` (the existing local
 * release-directory seam). Both are local-only and never set on a production
 * endpoint, so they share the read-side allowance.
 */
export function allowLocalTestFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return resolveLocalTestContext(env).allowLocalTest || env.MOEICONS_FREE_RELEASE_DIR !== undefined;
}
