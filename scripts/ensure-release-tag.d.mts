export function ensureReleaseTag(input: {
  repo?: string;
  tag: string;
  commit: string;
  token: string;
  fetchImpl?: (url: string, init?: { method?: string; body?: string }) => unknown;
}): Promise<{ status: string; repo: string; tag: string; commit: string; created: boolean }>;
