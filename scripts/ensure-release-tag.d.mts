export function ensureReleaseTag(options: {
  repo?: string;
  tag: string;
  commit: string;
  token: string;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
}): Promise<{ status: 'verified'; repo: string; tag: string; commit: string; created: boolean }>;
