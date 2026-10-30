import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { flushDecisionLog } from "../decision-log.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhoneHost } from "./host.ts";
import { PhoneJobs } from "./jobs.ts";
import { PhoneRegistry, type PhoneRegistration } from "./registry.ts";

const KEY = "session:phone-1";
const TURN = { botId: "helper", threadId: "thread-1", generation: "gen-1" };
const registration: PhoneRegistration = {
  installId: "install-0001", name: "Fixture phone", platform: "ios", appVersion: "1.0.0",
  timeZone: "UTC", capabilities: { calendar: "full" },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "phone-host-revocation-"));
  const registry = new PhoneRegistry(join(dir, "phones.json"));
  const jobs = new PhoneJobs();
  cleanups.push(async () => { jobs.close(); await flushDecisionLog(dir); await removeTempDir(dir); });
  registry.register(KEY, "owner", registration);
  const state = {
    bot: { id: "helper", name: "Helper", phoneApps: { calendar: "write" } } as BotRecord | null,
    owner: "owner" as string | null,
  };
  const messages: unknown[] = [];
  const host = createPhoneHost({
    registry, jobs, dataDir: dir, bot: () => state.bot, turnOwner: () => state.owner,
    inRoom: () => false, appendMessage: (_thread, message) => { messages.push(message); }, active: () => true,
  });
  const request = () => host.handle({ method: "tools/call", params: { name: "PHONE_DELETE_EVENT", arguments: { id: "event-1" } } }, TURN, () => {});
  return { registry, jobs, state, messages, request };
}

type Fixture = ReturnType<typeof fixture>;
const changes: Array<[string, (h: Fixture) => void]> = [
  ["the bot's calendar grant is removed", h => { h.state.bot!.phoneApps = {}; }],
  ["the bot's calendar grant becomes read only", h => { h.state.bot!.phoneApps = { calendar: "read" }; }],
  ["the bot is deleted", h => { h.state.bot = null; }],
  ["the turn loses ownership", h => { h.state.owner = null; }],
  ["the turn changes owner", h => { h.state.owner = "another-owner"; }],
  ["the selected phone changes owner", h => { h.registry.register(KEY, "another-owner", registration); }],
  ["the selected phone loses Calendar", h => { h.registry.register(KEY, "owner", { ...registration, capabilities: {} }); }],
  ["the selected phone is removed", h => { h.registry.remove(KEY); }],
];

describe.each(changes)("phone job revocation when %s", (_name, revoke) => {
  it("does not dequeue the queued deletion", async () => {
    const h = fixture();
    const blocking = h.jobs.request(KEY, "PHONE_LIST_EVENTS", {}, { active: () => true, timeoutMs: 45_000, offlineText: "offline", online: () => true });
    const first = (await h.jobs.poll(KEY))!;
    expect(h.jobs.lease(KEY, first.id)).toBe(true);
    const pending = h.request();
    revoke(h);
    h.jobs.complete(KEY, first.id, { ok: true, result: { events: [] } });
    await blocking;
    const gone = new AbortController();
    const poll = h.jobs.poll(KEY, gone.signal);
    gone.abort();
    expect(await poll).toBeNull();
    expect(await pending).toMatchObject({ isError: true });
    expect(h.messages).toEqual([]);
  });

  it("refuses a lease for the delivered deletion", async () => {
    const h = fixture();
    const pending = h.request();
    const job = (await h.jobs.poll(KEY))!;
    revoke(h);
    expect(h.jobs.lease(KEY, job.id)).toBe(false);
    expect(await pending).toMatchObject({ isError: true });
    expect(h.messages).toEqual([]);
  });

  it("refuses a result for the leased deletion", async () => {
    const h = fixture();
    const pending = h.request();
    const job = (await h.jobs.poll(KEY))!;
    expect(h.jobs.lease(KEY, job.id)).toBe(true);
    revoke(h);
    expect(() => h.jobs.complete(KEY, job.id, { ok: true, result: { deleted: true } })).toThrow(/expired/);
    expect(await pending).toMatchObject({ isError: true });
    expect(h.messages).toEqual([]);
    expect(h.registry.get(KEY)?.lastUsedAt ?? null).toBeNull();
  });
});
