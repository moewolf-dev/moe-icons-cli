export function buildCliPackageSetDelivery(input: {
  resource: Record<string, any>;
  receipt: Record<string, any>;
  run: Record<string, any>;
  publishRunId: string | number;
}): { eventId: string; delivery: Record<string, any> };
