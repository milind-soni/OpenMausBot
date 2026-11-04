import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { personKey } from "../person-key.ts";
import { createNoAiNotice } from "./no-ai-notice.ts";
import type { Delivery } from "./person-inbox.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const BEN = { email: "ben@acme.test", role: "admin" as const };
const DANA = { email: "dana@acme.test", role: "member" as const };
const MARA = { email: "mara@acme.test", role: "member" as const };
const key = (email: string) => personKey({ id: "", email });
const said = (person: { email: string }) => ({ name: person.email, id: key(person.email) });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(over: { team?: null; reachable?: () => boolean; dataDir?: string } = {}) {
  const dataDir = over.dataDir ?? mkdtempSync(join(tmpdir(), "omb-no-ai-"));
  if (!over.dataDir) dirs.push(dataDir);
  const lines: Array<{ to: string; delivery: Delivery }> = [];
  const world = { people: [OLIVE, BEN, DANA, MARA] as Array<typeof OLIVE | typeof BEN | typeof DANA>, now: 1_000 };
  const make = () => createNoAiNotice({
    team: over.team === null ? null : { id: "team-acme", name: "Acme" }, dataDir,
    people: () => world.people, personName: (person) => (person === key(OLIVE.email) ? "Olive" : undefined),
    inbox: () => ({ deliver: (to, delivery) => { if (over.reachable && !over.reachable()) return null; lines.push({ to, delivery }); return { threadId: `inbox-${to}` }; } }),
    language: () => undefined, threadLanguage: () => undefined, now: () => world.now,
  });
  return { notice: make(), make, lines, world, dataDir };
}

describe("a Send with no AI on a team", () => {
  it("stays out of the way for a bot on an engine this server no longer has: that isn't a missing AI", () => {
    const { notice, lines } = fixture();
    expect(notice.refusal("t1", said(DANA), "claude")).toBeNull();
    expect(lines).toEqual([]);
  });

  it("tells a User who connects it, as the app's own kind of refusal, and tells the owner in their inbox", () => {
    const { notice, lines } = fixture();
    const refused = notice.refusal("t1", said(DANA));
    expect(refused).toMatchObject({ status: 409, code: "no_ai", message: "Olive needs to connect an AI before bots can answer. I've told them." });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.to).toBe(key(OLIVE.email));
    expect(lines[0]!.delivery).toMatchObject({ kind: "notice", from: { name: "Dana", email: DANA.email }, title: "Connect an AI for Acme",
      text: "Dana tried to use a bot in Acme, but no AI is connected yet. Connect one so bots can answer." });
  });

  it("tells the owner at most once a day for each person, and still says so to them", () => {
    const { notice, lines, world } = fixture();
    notice.refusal("t1", said(DANA));
    expect(notice.refusal("t1", said(DANA))?.message).toContain("I've told them");
    expect(lines, "the same person again").toHaveLength(1);
    notice.refusal("t2", said(MARA));
    expect(lines, "another person").toHaveLength(2);
    world.now += 24 * 60 * 60_000;
    notice.refusal("t1", said(DANA));
    expect(lines, "a day later").toHaveLength(3);
  });

  it("keeps the once a day across a restart", () => {
    const first = fixture();
    first.notice.refusal("t1", said(DANA));
    const again = fixture({ dataDir: first.dataDir });
    again.notice.refusal("t1", said(DANA));
    expect(again.lines).toEqual([]);
  });

  it("never says it told an owner it can't reach: it says it will, and does when they first open the team", () => {
    const { notice, make, lines, world, dataDir } = fixture();
    world.people = [DANA, MARA];
    expect(notice.refusal("t1", said(DANA))?.message).toBe("The team's owner needs to connect an AI before bots can answer. I'll tell them when they first open the team.");
    notice.refusal("t1", said(DANA));
    expect(lines).toEqual([]);
    notice.flush();
    expect(lines, "the owner still isn't here").toEqual([]);
    world.people = [OLIVE, DANA, MARA];
    const restarted = make();
    restarted.flush();
    expect(lines.map((line) => [line.to, line.delivery.from.email])).toEqual([[key(OLIVE.email), DANA.email]]);
    restarted.flush();
    expect(lines, "once").toHaveLength(1);
    restarted.refusal("t1", said(DANA));
    expect(lines, "and that counts as today's").toHaveLength(1);
    expect(dataDir).toBeTruthy();
  });

  it("says it will tell an owner whose inbox can't be made yet, and keeps them waiting", () => {
    let reachable = false;
    const { notice, lines } = fixture({ reachable: () => reachable });
    expect(notice.refusal("t1", said(DANA))?.message).toContain("I'll tell them");
    expect(lines).toEqual([]);
    reachable = true;
    notice.flush();
    expect(lines).toHaveLength(1);
  });

  it("asks an admin to connect one, and a run nobody started by hand says nothing can run; neither tells anyone", () => {
    const { notice, lines } = fixture();
    expect(notice.refusal("t1", said(BEN))?.message).toBe("Connect an AI first, so bots can answer.");
    expect(notice.refusal("t1", said(OLIVE))?.message).toBe("Connect an AI first, so bots can answer.");
    expect(notice.refusal("t1", undefined)).toMatchObject({ code: "no_ai", message: "No AI is connected yet, so nothing can run." });
    expect(lines).toEqual([]);
  });

  it("is nothing off a team", () => {
    const { notice, lines } = fixture({ team: null });
    expect(notice.refusal("t1", said(DANA))).toBeNull();
    notice.flush();
    expect(lines).toEqual([]);
  });
});
