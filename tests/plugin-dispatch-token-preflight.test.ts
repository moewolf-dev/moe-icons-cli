import { describe, expect, it } from 'vitest';
import { assertProbeEventUnhandled, PROBE_EVENT_TYPE } from '../scripts/preflight-plugin-dispatch-token.mjs';

describe('PLUGIN_DISPATCH_TOKEN preflight safety', () => {
  it('accepts only an unhandled probe while checking the target receiver', () => {
    const result = assertProbeEventUnhandled([
      {
        path: '.github/workflows/resource-update.yml',
        text: 'on:\n  repository_dispatch:\n    types: [moe-icons-code-library-release, moe-icons-cli-release]\n',
      },
    ]);
    expect(result.probeEventType).toBe(PROBE_EVENT_TYPE);
    expect(result.listenerWorkflows).toEqual(['.github/workflows/resource-update.yml']);
  });

  it('fails closed if the target receiver is not present', () => {
    expect(() => assertProbeEventUnhandled([
      { path: '.github/workflows/other.yml', text: 'on:\n  repository_dispatch:\n    types: [other-event]\n' },
    ])).toThrow(/receiver was not found/);
  });

  it('fails closed when any repository dispatch listener is unfiltered', () => {
    expect(() => assertProbeEventUnhandled([
      { path: '.github/workflows/resource-update.yml', text: 'on:\n  repository_dispatch:\n    types: [resource-update]\n' },
      { path: '.github/workflows/catch-all.yml', text: 'on:\n  repository_dispatch:\n' },
    ])).toThrow(/unfiltered repository_dispatch listener/);
  });

  it('fails closed if any listener subscribes to the probe type', () => {
    expect(() => assertProbeEventUnhandled([
      { path: '.github/workflows/resource-update.yml', text: `on:\n  repository_dispatch:\n    types: [${PROBE_EVENT_TYPE}]\n` },
    ])).toThrow(/subscribes to the permission probe event/);
  });
});
