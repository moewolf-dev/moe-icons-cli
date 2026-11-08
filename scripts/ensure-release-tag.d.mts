export function ensureReleaseTag(input: {
  repo?: string;
  tag: string;
  commit: string;
  token: string;
  // The production code passes fetch; tests inject narrow stubs.
  fetchImpl?: (...args: any[]) => any;
}): Promise<{ status: string; repo: string; tag: string; commit: string; created: boolean }>;
