export const TARGET_REPOSITORY: string;
export const PROBE_EVENT_TYPE: string;

export function assertProbeEventUnhandled(
  workflows: Array<{ path: string; text: string }>,
  probeEventType?: string,
): { listenerWorkflows: string[]; probeEventType: string };
