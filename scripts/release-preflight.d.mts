export interface PreflightResult {
  readonly published: boolean;
}

export interface CheckVersionPublishedOptions {
  readonly version: string;
  readonly registryUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

export declare function checkVersionPublished(
  options?: CheckVersionPublishedOptions,
): Promise<PreflightResult>;

export declare function runPreflight(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number>;
