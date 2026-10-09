export interface RegistryCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export interface WaitForRegistryPackageOptions {
  packageName: string;
  version: string;
  runCommand?: (command: string, args: string[]) => RegistryCommandResult;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  maxWaitMs?: number;
  retryDelaysMs?: number[];
}

export interface WaitForRegistryPackageResult {
  packageName: string;
  version: string;
  attempts: number;
  elapsedMs: number;
  smokeOutput: string;
}

export function waitForRegistryPackage(
  options: WaitForRegistryPackageOptions,
): Promise<WaitForRegistryPackageResult>;
