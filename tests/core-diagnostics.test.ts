import { describe, expect, it } from "vitest";
import {
  DiagnosticRecorder,
  DiagnosticRingBuffer,
  RING_BUFFER_MAX_BYTES,
  RING_BUFFER_MAX_EVENTS,
  createOperationId,
  diagnosticsFor,
} from "../src/core/diagnostics.js";

describe("REF-08 in-process diagnostics", () => {
  it("bounds the ring buffer by count and drops the oldest events", () => {
    const ring = new DiagnosticRingBuffer(3, 1024);
    for (let index = 0; index < 5; index += 1) {
      ring.push({ at: new Date(index).toISOString(), level: "debug", message: `event-${index}` });
    }
    expect(ring.snapshot().map((event) => event.message)).toEqual([
      "event-2",
      "event-3",
      "event-4",
    ]);
    expect(ring.droppedCount).toBe(2);
    expect(ring.size).toBe(3);
  });

  it("bounds total bytes even when events are few but large", () => {
    const ring = new DiagnosticRingBuffer(RING_BUFFER_MAX_EVENTS, 1_000);
    for (let index = 0; index < 5; index += 1) {
      ring.push({ at: new Date().toISOString(), level: "info", message: "x".repeat(400) });
    }
    expect(ring.byteSize).toBeLessThanOrEqual(1_000);
    expect(ring.size).toBeLessThanOrEqual(3);
  });

  it("keeps at most 20 events for a diagnostic bundle by default", () => {
    const recorder = new DiagnosticRecorder();
    for (let index = 0; index < 30; index += 1) {
      recorder.record({ level: "info", message: `m${index}` });
    }
    expect(recorder.lastEvents()).toHaveLength(20);
    expect(recorder.lastEvents().at(-1)?.message).toBe("m29");
  });

  it("mirrors redacted events to the debug stderr sink", () => {
    const lines: string[] = [];
    const recorder = new DiagnosticRecorder({
      debug: true,
      stderr: (text) => lines.push(text),
      redact: { cwd: "/Users/alice/app" },
    });
    recorder.record({
      level: "error",
      phase: "download",
      code: "NETWORK_ERROR",
      message: "failed for buyer@example.com at /Users/alice/app/file",
      operationId: "op_1",
    });
    const output = lines.join("");
    expect(output).toContain("debug [error]");
    expect(output).toContain("phase=download");
    expect(output).toContain("op=op_1");
    expect(output).not.toContain("buyer@example.com");
    expect(output).not.toContain("/Users/alice");
  });

  it("isolates sink failures and appends exactly one diagnostic warning", () => {
    const recorder = new DiagnosticRecorder({
      debug: true,
      stderr: () => {
        throw new Error("stderr closed");
      },
    });
    expect(() => recorder.record({ level: "error", message: "business failure" })).not.toThrow();
    const events = recorder.lastEvents(10);
    expect(events.at(-1)?.code).toBe("DIAGNOSTIC_WRITE_FAILED");
    expect(events.filter((event) => event.code === "DIAGNOSTIC_WRITE_FAILED")).toHaveLength(1);
    expect(events[0]?.message).toBe("business failure");
  });

  it("scopes one recorder per runtime object", () => {
    const first = {};
    const second = {};
    expect(diagnosticsFor(first)).toBe(diagnosticsFor(first));
    expect(diagnosticsFor(first)).not.toBe(diagnosticsFor(second));
  });

  it("creates short PII-free operation ids", () => {
    const ids = new Set(Array.from({ length: 20 }, () => createOperationId()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^op_[0-9a-f]{8}$/);
  });
});
