import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemorySessionStore } from "../lib/session-store.js";

describe("MemorySessionStore", () => {
  let store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new MemorySessionStore();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it("set and get a value", async () => {
    await store.set("key1", { data: "hello" }, 60);
    const result = await store.get("key1");
    expect(result).toEqual({ data: "hello" });
  });

  it("returns null for missing key", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("delete removes a key", async () => {
    await store.set("key1", "value", 60);
    await store.delete("key1");
    const result = await store.get("key1");
    expect(result).toBeNull();
  });

  it("expires entries after TTL", async () => {
    await store.set("key1", "value", 5); // 5 seconds TTL
    vi.advanceTimersByTime(6000); // advance 6 seconds
    const result = await store.get("key1");
    expect(result).toBeNull();
  });

  it("does not expire entries before TTL", async () => {
    await store.set("key1", "value", 10);
    vi.advanceTimersByTime(5000); // advance 5 seconds (within TTL)
    const result = await store.get("key1");
    expect(result).toBe("value");
  });

  it("cleanup removes expired entries", async () => {
    await store.set("expired", "old", 1);
    await store.set("valid", "new", 3600);
    vi.advanceTimersByTime(2000);
    const removed = await store.cleanup();
    expect(removed).toBe(1);
    expect(await store.get("expired")).toBeNull();
    expect(await store.get("valid")).toBe("new");
  });

  it("has returns true for existing key", async () => {
    await store.set("key1", "value", 60);
    expect(await store.has("key1")).toBe(true);
  });

  it("has returns false for missing key", async () => {
    expect(await store.has("nonexistent")).toBe(false);
  });

  it("has returns false for expired key", async () => {
    await store.set("key1", "value", 1);
    vi.advanceTimersByTime(2000);
    expect(await store.has("key1")).toBe(false);
  });

  it("keys returns all non-expired keys", async () => {
    await store.set("a", 1, 60);
    await store.set("b", 2, 60);
    await store.set("c", 3, 1);
    vi.advanceTimersByTime(2000);
    const keys = await store.keys();
    expect(keys.sort()).toEqual(["a", "b"]);
  });
});
