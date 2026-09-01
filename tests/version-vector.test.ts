import { describe, expect, it } from "vitest";
import { compareVectors, incrementVector, mergeVectors, validateVector } from "../src/sync/version-vector";

describe("version vectors", () => {
  it("orders causal changes", () => {
    expect(compareVectors({ deviceA1: 1 }, { deviceA1: 2 })).toBe("before");
    expect(compareVectors({ deviceA1: 3 }, { deviceA1: 2 })).toBe("after");
    expect(compareVectors({ deviceA1: 2 }, { deviceA1: 2 })).toBe("equal");
  });

  it("detects concurrent changes", () => {
    expect(compareVectors({ deviceA1: 2, deviceB1: 1 }, { deviceA1: 1, deviceB1: 2 }))
      .toBe("concurrent");
  });

  it("merges and increments without losing peer counters", () => {
    const merged = mergeVectors({ deviceA1: 3 }, { deviceA1: 2, deviceB1: 4 });
    expect(merged).toEqual({ deviceA1: 3, deviceB1: 4 });
    expect(incrementVector(merged, "deviceA1", 5)).toEqual({ deviceA1: 5, deviceB1: 4 });
  });

  it("rejects malformed vectors", () => {
    expect(validateVector({ deviceA1: 1 })).toBe(true);
    expect(validateVector({ short: 1 })).toBe(false);
    expect(validateVector({ deviceA1: 0 })).toBe(false);
    expect(validateVector({ deviceA1: 1.5 })).toBe(false);
  });
});
