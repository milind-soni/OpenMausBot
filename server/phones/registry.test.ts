import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as atomic from "../atomic.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { MAX_BLOCKED, MAX_PHONES, PHONE_ONLINE_MS, PHONE_REMOVED_TEXT, phoneRegistration, PhoneRegistry, type PhoneRegistration } from "./registry.ts";

const reg = (over: Partial<PhoneRegistration> = {}): PhoneRegistration => ({ installId: "inst-aaaaaaaa", name: "Omkar's iPhone", platform: "ios", appVersion: "1.9.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full", contacts: "limited" }, ...over });

describe("PhoneRegistry", () => {
  let dir: string;
  let file: string;
  let at: number;
  const now = () => at;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-phones-")); file = join(dir, "phones.json"); at = 1_000_000; });
  afterEach(async () => { vi.restoreAllMocks(); await removeTempDir(dir); });

  it("registers, lists online, and persists across a reload", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("companion:d1", "owner", reg());
    const listed = registry.list(null, () => false);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: "companion:d1", online: true, busy: false, registeredAt: at });
    expect(listed[0]).not.toHaveProperty("owner");
    at += 61_000;
    const reloaded = new PhoneRegistry(file, now);
    expect(reloaded.get("companion:d1")?.owner).toBe("owner");
    const again = reloaded.list(null, () => false);
    expect(again).toHaveLength(1);
    expect(again[0]!.online).toBe(false);
    expect(PHONE_ONLINE_MS).toBe(60_000);
  });

  it("re-registration under a new key replaces the old record", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("session:s1", "owner", reg());
    registry.used("session:s1");
    const first = registry.get("session:s1")!;
    at += 5_000;
    registry.register("session:s2", "owner", reg());
    const listed = registry.list(null, () => false);
    expect(listed.map((phone) => phone.key)).toEqual(["session:s2"]);
    expect(registry.get("session:s1")).toBeUndefined();
    expect(listed[0]).toMatchObject({ registeredAt: first.registeredAt, lastUsedAt: first.lastUsedAt });
  });

  it("keeps another owner's phone with the same installId", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("session:s1", "a", reg());
    registry.register("session:s2", "b", reg());
    expect(registry.list(null, () => false)).toHaveLength(2);
    expect(registry.forOwner("a")).toHaveLength(1);
    expect(registry.list("b", () => false).map((phone) => phone.key)).toEqual(["session:s2"]);
  });

  it("refuses the 21st phone with 409", () => {
    const registry = new PhoneRegistry(file, now);
    for (let i = 0; i < MAX_PHONES; i++) registry.register(`session:s${i}`, `o${i}`, reg({ installId: `inst-${String(i).padStart(8, "0")}` }));
    expect(() => registry.register("session:extra", "x", reg({ installId: "inst-extra000" }))).toThrow(expect.objectContaining({ message: "Too many phones", status: 409 }));
    expect(() => registry.register("session:s0", "o0", reg({ installId: "inst-00000000", name: "renamed" }))).not.toThrow();
  });

  it("marks busy from the callback", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("companion:d1", "owner", reg());
    expect(registry.list(null, () => true)[0]!.busy).toBe(true);
    expect(registry.list(null, (key) => key === "other")[0]!.busy).toBe(false);
  });

  it("remove drops the record and the mirror line", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("companion:d1", "owner", reg());
    expect(registry.remove("companion:d1")).toBe(true);
    expect(registry.remove("companion:d1")).toBe(false);
    expect(registry.get("companion:d1")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, phones: [], blocked: [] });
    expect(new PhoneRegistry(file, now).list(null, () => false)).toEqual([]);
    // The phone removing itself may register again at once.
    expect(() => registry.register("companion:d1", "owner", reg())).not.toThrow();
  });

  it("a phone removed on the computer stays refused across a restart until it pairs again", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("session:s1", "owner", reg());
    expect(registry.remove("session:s1", { block: true })).toBe(true);
    expect(registry.blocked("session:s1")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, phones: [], blocked: ["session:s1"] });
    const reloaded = new PhoneRegistry(file, now);
    expect(reloaded.blocked("session:s1")).toBe(true);
    expect(() => reloaded.register("session:s1", "owner", reg())).toThrow(expect.objectContaining({ message: PHONE_REMOVED_TEXT, status: 403 }));
    expect(reloaded.get("session:s1")).toBeUndefined();
    // Pairing again gives the phone a new key, which registers.
    expect(reloaded.register("session:s2", "owner", reg()).key).toBe("session:s2");
    // Blocking a key already gone still records it; one too long for the file is never written.
    expect(reloaded.remove("session:gone", { block: true })).toBe(false);
    expect(reloaded.blocked("session:gone")).toBe(true);
    expect(reloaded.remove(`session:${"x".repeat(400)}`, { block: true })).toBe(false);
    expect(new PhoneRegistry(file, now).list(null, () => false).map((phone) => phone.key)).toEqual(["session:s2"]);
  });

  it("keeps only the newest blocks", () => {
    const registry = new PhoneRegistry(file, now);
    for (let i = 0; i <= MAX_BLOCKED; i++) registry.remove(`session:s${i}`, { block: true });
    expect(registry.blocked("session:s0")).toBe(false);
    expect(registry.blocked("session:s1")).toBe(true);
    expect(registry.blocked(`session:s${MAX_BLOCKED}`)).toBe(true);
    expect(new PhoneRegistry(file, now).blocked(`session:s${MAX_BLOCKED}`)).toBe(true);
  });

  it.each([false, true])("reports a failed removal save and persists its retry (block=%s)", (block) => {
    const registry = new PhoneRegistry(file, now);
    registry.register("session:s1", "owner", reg());
    const saved = readFileSync(file, "utf8");
    const fault = Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    const write = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw fault; });
    expect(() => registry.remove("session:s1", { block })).toThrow(fault);
    expect(registry.get("session:s1")).toBeUndefined();
    expect(registry.blocked("session:s1")).toBe(block);
    expect(readFileSync(file, "utf8")).toBe(saved);
    if (block) expect(() => registry.register("session:s1", "owner", reg())).toThrow(expect.objectContaining({ status: 403 }));
    write.mockRestore();
    expect(registry.remove("session:s1", { block })).toBe(false);
    const reloaded = new PhoneRegistry(file, now);
    expect(reloaded.get("session:s1")).toBeUndefined();
    expect(reloaded.blocked("session:s1")).toBe(block);
  });

  it("retries storing a failed block even when the key was already absent", () => {
    const registry = new PhoneRegistry(file, now);
    const fault = Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    const write = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw fault; });
    expect(() => registry.remove("session:gone", { block: true })).toThrow(fault);
    expect(registry.blocked("session:gone")).toBe(true);
    write.mockRestore();
    expect(registry.remove("session:gone", { block: true })).toBe(false);
    expect(new PhoneRegistry(file, now).blocked("session:gone")).toBe(true);
  });

  it("reads a file written before blocks existed", () => {
    writeFileSync(file, JSON.stringify({ version: 1, phones: [{ key: "companion:d1", owner: "owner", registration: reg(), registeredAt: 1, seen: 1, lastUsedAt: null }] }));
    const registry = new PhoneRegistry(file, now);
    expect(registry.get("companion:d1")?.owner).toBe("owner");
    expect(registry.blocked("companion:d1")).toBe(false);
  });

  it("a newer phone's registration registers: an unknown field is stripped and an unknown app dropped", () => {
    const parsed = phoneRegistration.safeParse({ ...reg(), pushToken: "abc", capabilities: { calendar: "full", inbox: ["whatsapp:Family", "sms"], contacts: "limited" } });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(reg());
    const registry = new PhoneRegistry(file, now);
    registry.register("companion:d1", "owner", parsed.data!);
    expect(new PhoneRegistry(file, now).get("companion:d1")?.registration.capabilities).toEqual({ calendar: "full", contacts: "limited" });
    // A known app with a malformed grant is still refused.
    expect(phoneRegistration.safeParse({ ...reg(), capabilities: { calendar: "" } }).success).toBe(false);
  });
});
