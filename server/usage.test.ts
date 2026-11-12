import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { UsageStore } from "./usage.ts";
import { USAGE_STALE_MS } from "./usage-types.ts";

describe("UsageStore", () => {
  it("merges sparse updates across windows and persists them atomically", () => {
    let now = Date.parse("2026-11-12T12:00:00Z");
    const store = new UsageStore(DATA_DIR, () => now);
    store.merge("codex", { source: "reported", windows: [{ id: "primary", label: "5-hour allowance", remainingPercent: 80, resetsAt: "2026-11-12T17:00:00Z" }, { id: "weekly", label: "Weekly allowance", remainingPercent: 30 }] });
    now += 1000;
    store.merge("codex", { source: "reported", windows: [{ id: "primary", remainingPercent: null, resetsAt: null }] });
    const reloaded = new UsageStore(DATA_DIR, () => now).get("codex");
    expect(reloaded.status).toBe("low");
    expect(reloaded.windows[0]).toMatchObject({ label: "5-hour allowance", remainingPercent: 80, resetsAt: "2026-11-12T17:00:00Z" });
    expect(reloaded.windows[1].remainingPercent).toBe(30);
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "usage.json"), "utf8"));
    expect(disk[0].instanceId).toBe("codex");
    store.merge("codex", { source: "reported", updatedAt: "2020-01-01T00:00:00Z", windows: [{ id: "primary", remainingPercent: 0 }] });
    expect(store.get("codex").windows[0].remainingPercent).toBe(80);
  });
  it("does not turn a sparse healthy update or a passed refresh into recovery", () => {
    let now = Date.parse("2026-11-12T12:00:00Z");
    const store = new UsageStore(join(DATA_DIR, "exhausted"), () => now);
    store.merge("c", { source: "inferred", status: "exhausted" });
    store.merge("c", { source: "reported", windows: [{ id: "p", remainingPercent: 50, resetsAt: "2026-11-12T12:01:00Z" }] });
    expect(store.get("c").status).toBe("exhausted");
    now += 61_000;
    expect(store.get("c").status).toBe("exhausted");
    expect(store.get("c").windows[0].remainingPercent).toBeNull();
    store.merge("c", { source: "reported", status: "ok", windows: [{ id: "p", remainingPercent: 80, resetsAt: "2026-11-12T18:00:00Z" }] });
    expect(store.get("c").status).toBe("ok");
  });
  it("makes stale windows unknown without refreshing them through unrelated updates", () => {
    let now = Date.parse("2026-11-12T12:00:00Z");
    const store = new UsageStore(join(DATA_DIR, "stale"), () => now);
    expect(store.get("missing").status).toBe("unknown");
    store.merge("c", { source: "reported", windows: [{ id: "p", remainingPercent: 70 }] });
    now += USAGE_STALE_MS + 1;
    expect(store.get("c")).toMatchObject({ status: "unknown", windows: [{ remainingPercent: null }] });
    store.merge("c", { source: "reported", windows: [{ id: "w", remainingPercent: 60 }] });
    expect(store.get("c").windows[0].remainingPercent).toBeNull();
    expect(store.get("c").windows[1].remainingPercent).toBe(60);
  });
});
