import { describe, expect, it } from "vitest";
import { PendingStore } from "../src/pending.js";

describe("PendingStore", () => {
  it("returns the stored value once", () => {
    const store = new PendingStore<string>(1000);
    const { token } = store.put("plan");
    expect(store.take(token)).toBe("plan");
    expect(() => store.take(token)).toThrow("이미 사용한");
  });

  it("rejects an unknown token", () => {
    expect(() => new PendingStore<string>(1000).take("nope")).toThrow("알 수 없거나");
  });

  it("expires after the ttl but not at the exact boundary", () => {
    let now = 0;
    const store = new PendingStore<string>(1000, () => now);
    const a = store.put("a");
    const b = store.put("b");
    now = 1000;
    expect(store.take(a.token)).toBe("a");
    now = 1001;
    expect(() => store.take(b.token)).toThrow("만료");
  });
});
