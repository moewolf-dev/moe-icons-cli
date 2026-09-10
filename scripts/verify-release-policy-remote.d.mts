export interface VerifyRemotePolicyOptions {
  root?: string;
  fetchImpl?: typeof fetch;
  rawBase?: string;
  signal?: AbortSignal;
}

export interface VerifyRemotePolicyResult {
  sha256: string;
  sourceCommit: string;
  url: string;
}

export function verifyRemotePolicy(
  options?: VerifyRemotePolicyOptions,
): Promise<VerifyRemotePolicyResult>;
