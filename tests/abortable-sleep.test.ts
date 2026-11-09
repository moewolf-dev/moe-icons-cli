import { describe, expect, it, vi } from "vitest";
import { abortableSleep } from "../src/auth/abortable-sleep.js";

describe("abortable login polling sleep", () => {
  it("removes its abort listener after each normal polling interval", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await abortableSleep(0, controller.signal);
    }

    const abortAdds = add.mock.calls.filter(([type]) => type === "abort");
    const abortRemoves = remove.mock.calls.filter(([type]) => type === "abort");
    expect(abortAdds).toHaveLength(20);
    expect(abortRemoves).toHaveLength(20);
  });

  it("removes the listener and stops the timer when login is cancelled", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = abortableSleep(60_000, controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
  });

  it("does not register a listener when cancellation already happened", async () => {
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, "addEventListener");

    await expect(abortableSleep(0, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(add).not.toHaveBeenCalled();
  });
});
