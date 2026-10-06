import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TrustedContacts } from "./trusted-contacts.ts";

const roots: string[] = [];
const start = Date.parse("2026-11-01T09:00:00Z");
const end = start + 3600000;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-contacts-")); roots.push(root);
  const file = join(root, "contacts.json");
  let now = start - 86400000;
  const options = { file, now: () => now, botExists: (id: string) => id === "bot" };
  const service = new TrustedContacts(options);
  service.configure({ botId: "bot", source: "manual", slots: [{ start, end }], calendarIds: ["primary"] });
  const { contact, token } = service.createContact({ name: "Priya", botId: "bot" });
  service.grant(contact.id, { capabilities: ["availability", "propose"], start, end, expiresAt: end });
  return { service, options, file, contact, token, advance: (time: number) => { now = time; } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const availability = { id: "request-1", kind: "availability" as const, start, end, durationMinutes: 30 };
const proposal = { id: "proposal-1", kind: "proposal" as const, start, end: start + 1800000, subject: "Coffee" };

it("returns only scoped free intervals and never exposes contact credentials", async () => {
  const f = fixture();
  expect((await f.service.receive(f.token, availability)).slots).toEqual([{ start, end: start + 1800000 }, { start: start + 1800000, end }]);
  expect(JSON.stringify(f.service.snapshot())).not.toContain(f.token);
  expect(readFileSync(f.file, "utf8")).not.toContain(f.token);
  await expect(f.service.receive(f.token, { ...availability, id: "outside", start: start - 1 })).rejects.toThrow("grant");
  await expect(f.service.receive("forged", availability)).rejects.toThrow("credential");
});
it("requires approval of the exact immutable proposal and survives restart", async () => {
  const f = fixture();
  const result = await f.service.receive(f.token, proposal);
  expect(result.status).toBe("pending");
  const restored = new TrustedContacts(f.options);
  expect(restored.snapshot().requests[0]?.status).toBe("pending");
  await expect(restored.receive(f.token, { ...proposal, subject: "Different" })).rejects.toThrow("different");
  const approved = await restored.decide(result.id, "approve");
  expect(approved.status).toBe("completed");
  expect(restored.invitation(result.id)).toContain("SUMMARY:Coffee");
  expect(await restored.receive(f.token, proposal)).toEqual(approved);
  await expect(restored.decide(result.id, "approve")).rejects.toThrow("pending");
});
it("revocation and expiry stop pending approvals and new requests", async () => {
  const f = fixture();
  const result = await f.service.receive(f.token, proposal);
  f.service.revoke(f.contact.id);
  await expect(f.service.decide(result.id, "approve")).rejects.toThrow("grant");
  await expect(f.service.receive(f.token, availability)).rejects.toThrow("grant");
  f.service.grant(f.contact.id, { capabilities: ["availability"], start, end, expiresAt: end });
  f.advance(end + 1);
  await expect(f.service.receive(f.token, availability)).rejects.toThrow("grant");
});
it("refuses another contact's results and conflicting confirmed meetings", async () => {
  const f = fixture();
  const other = f.service.createContact({ name: "Alex", botId: "bot" });
  const result = await f.service.receive(f.token, proposal);
  expect(() => f.service.result(other.token, result.id)).toThrow("request");
  await f.service.decide(result.id, "approve");
  const second = await f.service.receive(f.token, { ...proposal, id: "proposal-2" });
  await expect(f.service.decide(second.id, "approve")).rejects.toThrow("available");
  expect((await f.service.receive(f.token, availability)).slots).toEqual([{ start: start + 1800000, end }]);
});
it("rechecks grants after an asynchronous calendar read", async () => {
  const f = fixture();
  let release!: (value: Array<{ start: number; end: number }>) => void;
  const gate = new Promise<Array<{ start: number; end: number }>>(resolve => { release = resolve; });
  const service = new TrustedContacts({ ...f.options, busy: async () => gate });
  service.configure({ botId: "bot", source: "google", slots: [{ start, end }], calendarIds: ["primary"] });
  const pending = service.receive(f.token, availability);
  service.revoke(f.contact.id);
  release([]);
  await expect(pending).rejects.toThrow("grant");
  expect(service.snapshot().requests).toHaveLength(0);
});
it("failed persistence does not publish new contacts or approvals", async () => {
  const f = fixture();
  const result = await f.service.receive(f.token, proposal);
  const before = f.service.snapshot();
  renameSync(f.file, `${f.file}.saved`); mkdirSync(f.file);
  expect(() => f.service.createContact({ name: "Lost", botId: "bot" })).toThrow();
  await expect(f.service.decide(result.id, "approve")).rejects.toThrow();
  expect(f.service.snapshot()).toEqual(before);
});
it("denies malformed requests and never turns absent calendar data into free time", async () => {
  const f = fixture();
  await expect(f.service.receive(f.token, { ...availability, durationMinutes: 0 })).rejects.toThrow();
  await expect(f.service.receive(f.token, { ...availability, end: start })).rejects.toThrow();
  f.service.configure({ botId: "bot", source: "google", slots: [{ start, end }], calendarIds: ["primary"] });
  await expect(f.service.receive(f.token, availability)).rejects.toThrow("Calendar");
});
it("cannot confirm overlapping proposals concurrently", async () => {
  const f = fixture();
  const first = await f.service.receive(f.token, proposal);
  const second = await f.service.receive(f.token, { ...proposal, id: "second" });
  const results = await Promise.allSettled([f.service.decide(first.id, "approve"), f.service.decide(second.id, "approve")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
});
it("does not release an in-flight calendar result after rotating its credential", async () => {
  const f = fixture(); let release!: (busy: Array<{ start: number; end: number }>) => void;
  const service = new TrustedContacts({ ...f.options, busy: () => new Promise(resolve => { release = resolve; }) });
  service.configure({ botId: "bot", source: "google", slots: [{ start, end }], calendarIds: ["primary"] });
  const pending = service.receive(f.token, availability);
  service.rotate(f.contact.id); release([]);
  await expect(pending).rejects.toThrow("credential");
});
it("bounds concurrent external calendar work and counts unsuccessful attempts", async () => {
  const f = fixture(); let calls = 0; let release!: () => void;
  const service = new TrustedContacts({ ...f.options, busy: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return []; } });
  service.configure({ botId: "bot", source: "google", slots: [{ start, end }], calendarIds: ["primary"] });
  const first = service.receive(f.token, availability);
  await expect(service.receive(f.token, { ...availability, id: "parallel" })).rejects.toThrow("progress");
  expect(calls).toBe(1); release(); await first;
  const failing = new TrustedContacts({ ...f.options, busy: async () => { throw new Error("offline"); } });
  for (let i = 0; i < 60; i++) await expect(failing.receive(f.token, { ...availability, id: `fail-${i}` })).rejects.toThrow("offline");
  await expect(failing.receive(f.token, { ...availability, id: "over-limit" })).rejects.toThrow("limit");
});
it("rechecks permissions and availability immediately before committing an approval", async () => {
  const f = fixture(); const request = await f.service.receive(f.token, proposal);
  const pending = f.service.decide(request.id, "approve");
  f.service.revoke(f.contact.id);
  await expect(pending).rejects.toThrow("grant");
  f.service.grant(f.contact.id, { capabilities: ["availability", "propose"], start, end, expiresAt: end });
  const changed = f.service.decide(request.id, "approve");
  f.service.configure({ botId: "bot", source: "manual", slots: [], calendarIds: ["primary"] });
  await expect(changed).rejects.toThrow("changed");
  expect(f.service.snapshot().requests[0]?.status).toBe("pending");
});
it("does not release availability when configuration changes across its final await", async () => {
  const f = fixture(); const pending = f.service.receive(f.token, availability);
  f.service.configure({ botId: "bot", source: "manual", slots: [], calendarIds: ["primary"] });
  await expect(pending).rejects.toThrow("changed");
});
it("enforces configuration capacity before persistence and permits replacement at the limit", () => {
  const f = fixture(); const service = new TrustedContacts({ ...f.options, botExists: () => true });
  for (let i = 0; i < 199; i++) service.configure({ botId: `bot-${i}`, source: "manual", slots: [], calendarIds: ["primary"] });
  expect(() => service.configure({ botId: "excess", source: "manual", slots: [], calendarIds: ["primary"] })).toThrow("limit");
  service.configure({ botId: "bot", source: "manual", slots: [], calendarIds: ["primary"] });
  expect(new TrustedContacts({ ...f.options, botExists: () => true }).snapshot().calendars).toHaveLength(200);
});
