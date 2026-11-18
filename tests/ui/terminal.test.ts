import { describe, expect, it } from "vitest";
import {
  createTerminalDimensions,
  createThrottledPainter,
  fitLine,
  staticDimensions,
} from "../../src/ui/terminal.js";
import { visibleWidth, renderNoticeBox } from "../../src/ui/banner.js";

function resizeSource() {
  const listeners = new Set<() => void>();
  return {
    on(event: "resize", listener: () => void) {
      listeners.add(listener);
      return this;
    },
    removeListener(_event: "resize", listener: () => void) {
      listeners.delete(listener);
      return this;
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}

describe("REF-03 dimensions provider", () => {
  it("reads the live width at paint time and falls back for invalid values", () => {
    let columns: number | undefined = 120;
    const dimensions = createTerminalDimensions({ columns: () => columns });
    expect(dimensions.columns()).toBe(120);
    columns = 40;
    expect(dimensions.columns()).toBe(40);
    columns = 0;
    expect(dimensions.columns()).toBe(80);
    columns = undefined;
    expect(dimensions.columns()).toBe(80);
    columns = Number.NaN;
    expect(dimensions.columns()).toBe(80);
  });

  it("subscribes to resize only while a listener exists and removes it on dispose", () => {
    const source = resizeSource();
    let columns = 80;
    const dimensions = createTerminalDimensions({ columns: () => columns, stdout: source });
    const seen: number[] = [];
    const unsubscribe = dimensions.onResize((next) => seen.push(next));
    expect(source.size).toBe(1);
    columns = 60;
    source.emit();
    expect(seen).toEqual([60]);
    unsubscribe();
    expect(source.size).toBe(0);
    columns = 20;
    source.emit();
    expect(seen).toEqual([60]);
  });

  it("keeps one resize subscription for multiple listeners and removes it once", () => {
    const source = resizeSource();
    const dimensions = createTerminalDimensions({ columns: () => 80, stdout: source });
    const stopA = dimensions.onResize(() => undefined);
    const stopB = dimensions.onResize(() => undefined);
    expect(source.size).toBe(1);
    stopA();
    expect(source.size).toBe(1);
    stopB();
    expect(source.size).toBe(0);
  });

  it("never throws when a resize listener fails", () => {
    const source = resizeSource();
    const dimensions = createTerminalDimensions({ columns: () => 80, stdout: source });
    const seen: number[] = [];
    dimensions.onResize(() => {
      throw new Error("renderer failed");
    });
    dimensions.onResize((columns) => seen.push(columns));
    expect(() => source.emit()).not.toThrow();
    expect(seen).toEqual([80]);
    dimensions.dispose();
  });

  it("provides a static provider for tests", () => {
    expect(staticDimensions(20).columns()).toBe(20);
  });
});

describe("REF-03 throttled painter", () => {
  function harness(intervalMs = 100) {
    let now = 0;
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const paints: number[] = [];
    const painter = createThrottledPainter<number>((value) => paints.push(value), {
      intervalMs,
      now: () => now,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length - 1;
      },
      cancel: (handle) => {
        scheduled[handle as number] = { callback: () => undefined, delay: -1 };
      },
    });
    return {
      painter,
      paints,
      advance(ms: number) {
        now += ms;
      },
      runScheduled() {
        const next = scheduled.shift();
        next?.callback();
      },
      scheduled,
    };
  }

  it("paints immediately, coalesces rapid ticks, and flushes the latest value", () => {
    const test = harness();
    test.painter.update(1);
    expect(test.paints).toEqual([1]);
    test.painter.update(2);
    test.painter.update(3);
    expect(test.paints).toEqual([1]);
    expect(test.painter.paints).toBe(1);
    test.advance(100);
    test.runScheduled();
    expect(test.paints).toEqual([1, 3]);
    test.advance(100);
    test.painter.update(4);
    test.painter.flush();
    expect(test.paints.at(-1)).toBe(4);
  });

  it("does not paint after dispose", () => {
    const test = harness();
    test.painter.update(1);
    test.painter.update(2);
    test.painter.dispose();
    test.painter.update(3);
    test.painter.flush();
    expect(test.paints).toEqual([1]);
  });

  it("isolates painter failures from the caller", () => {
    const painter = createThrottledPainter(
      () => {
        throw new Error("terminal closed");
      },
      { intervalMs: 0 },
    );
    expect(() => painter.update(1)).not.toThrow();
  });
});

describe("REF-03 width and fitting", () => {
  it("counts grapheme clusters, not code points", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("e\u0301")).toBe(1);
    expect(visibleWidth("你好")).toBe(4);
    expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(visibleWidth("🇨🇳")).toBe(2);
    expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });

  it("fits a line by visible width without splitting a wide grapheme", () => {
    expect(fitLine("abcdef", 10)).toBe("abcdef");
    const fitted = fitLine("你好世界", 5);
    expect(visibleWidth(fitted)).toBeLessThanOrEqual(5);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("renders a plain-text box for an extremely narrow terminal", () => {
    const box = renderNoticeBox(["hello world"], { width: 10, unicode: false });
    for (const line of box.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    expect(box).toMatch(/^\+/);
    expect(box).not.toContain("┌");
  });
});
