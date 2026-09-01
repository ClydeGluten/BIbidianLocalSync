import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/sync/serial-queue";

describe("SerialQueue", () => {
  it("never overlaps asynchronous operations", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push("first:start");
      await Promise.resolve();
      order.push("first:end");
    });
    const second = queue.run(async () => {
      order.push("second:start");
      await Promise.resolve();
      order.push("second:end");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(queue.size).toBe(0);
  });
});
