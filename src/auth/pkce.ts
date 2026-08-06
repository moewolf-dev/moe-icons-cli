import { randomBytes, createHash } from "node:crypto";

/**
 * PKCE: cryptographically random verifier and S256 challenge.
 */

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** RFC 7636-compatible base64url without padding. */
function base64Url(input: Uint8Array | Buffer): string {
  return Buffer.from(input).toString("base64url").replace(/=+$/, "");
}

/**
 * Create a PKCE pair: 43-128 char verifier and S256 challenge.
 */
export function createPkcePair(): PkcePair {
  const verifierBytes = randomBytes(32); // 43 base64url chars
  const verifier = base64Url(verifierBytes);
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Login state (state + nonce) for a single active attempt. */
export interface LoginState {
  readonly state: string;
  readonly nonce: string;
}

export function createLoginState(): LoginState {
  return {
    state: base64Url(randomBytes(24)),
    nonce: base64Url(randomBytes(24)),
  };
}
