import { describe, expect, it } from "vitest";

import type { BotAccessLevel } from "../../shared/bot-access.ts";
import type { Message } from "../store.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RouteContext } from "../routes/table.ts";
import type { BotRecord } from "../store.ts";
import { personKey } from "../person-key.ts";
import { createAccessRequests } from "./access-requests.ts";
import type { Delivery } from "./person-inbox.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const key = (email: string) => personKey({ id: "", email });

function fixture(bot: Partial<BotRecord>) {
  const threads = new Map<string, Message[]>();
  const homes = new Map([OLIVE, ADA, BOB].map((person) => [key(person.email), `inbox-${person.email}`]));
  const levels: Record<string, BotAccessLevel> = { [OLIVE.email]: "edit", [ADA.email]: "edit", [BOB.email]: "view" };
  const writes: unknown[] = [];
  const record = { id: "ledger", name: "Ledger", threadId: "t-ledger", createdBy: "gone@acme.test", access: { everyone: "none", people: { [BOB.email]: "view" } }, ...bot } as BotRecord;
  const requests = createAccessRequests({
    team: { id: "team-acme", name: "Acme" } as never,
    store: () => ({
      bot: (id: string) => (id === record.id ? record : undefined),
      messagesFor: (threadId: string) => threads.get(threadId) ?? [],
      patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
        threads.set(threadId, (threads.get(threadId) ?? []).map((line) => (line.id === id ? { ...line, ...patch } : line)));
        return null;
      },
    }) as never,
    people: () => [OLIVE, ADA, BOB],
    profileName: () => undefined,
    inbox: () => ({
      deliver: (person: string, delivery: Delivery) => {
        const threadId = homes.get(person)!;
        threads.set(threadId, [...threads.get(threadId) ?? [], { id: `line-${threads.get(threadId)?.length ?? 0}`, role: "bot", kind: delivery.card ? "options" : "text", text: delivery.text, at: 0, ...(delivery.card ? { card: delivery.card } : {}) } as Message]);
        return { threadId };
      },
      personOf: (threadId: string) => [...homes].find(([, home]) => home === threadId)?.[0] ?? null,
      home: (person: string) => (homes.has(person) ? { threadId: homes.get(person)! } : null),
    }),
    visibleTo: (viewer) => ({ level: () => levels[viewer.email ?? ""] ?? "none" }) as unknown as VisibleSet,
    levelOf: (auth) => levels[auth.kind === "session" ? auth.session.email ?? "" : ""] ?? "none",
    writeAccess: (_bot, access) => { writes.push(access); return record; },
  });
  const ask = async (email: string) => {
    let answered: { status: number; body: unknown } | undefined;
    const auth = { kind: "session", session: { id: "s", email, membershipAuthority: "team" }, scopes: ["client"] } as unknown as RequestAuth;
    await requests.routes({ path: `/api/bots/${record.id}/access-request`, method: "POST", auth, res: {}, json: (_res: unknown, status: number, body: unknown) => { answered = { status, body }; } } as unknown as RouteContext);
    return answered!;
  };
  const cards = (email: string) => (threads.get(`inbox-${email}`) ?? []).filter((line) => line.card?.accessRequest);
  return { requests, ask, cards, writes, threads };
}

describe("asking to chat", () => {
  it("asks every admin when the bot's owner is no longer on the team, and one admin's Allow settles every copy", async () => {
    const { requests, ask, cards, writes } = fixture({});
    expect(await ask(BOB.email)).toMatchObject({ status: 201, body: { asked: [{ email: OLIVE.email }, { email: ADA.email }] } });
    expect((await ask(BOB.email)).status, "asked once").toBe(200);
    expect(cards(OLIVE.email)).toHaveLength(1);
    expect(cards(ADA.email)).toHaveLength(1);
    const card = cards(ADA.email)[0]!.card!;
    expect(requests.resolve(`inbox-${ADA.email}`, card.requestId!, "answer", "Allow")).toMatchObject({ status: 200, body: { outcome: "allowed" } });
    expect(writes).toEqual([{ everyone: "none", people: { [BOB.email]: "chat" } }]);
    expect(cards(OLIVE.email)[0]!.card).toMatchObject({ answered: "answer", answeredText: "Allow" });
    expect(requests.resolve(`inbox-${OLIVE.email}`, cards(OLIVE.email)[0]!.card!.requestId!, "answer", "Allow")?.status).toBe(409);
  });

  it("asks the owner alone while they are on the team, and Not now gives nothing", async () => {
    const { requests, ask, cards, writes } = fixture({ reportsTo: OLIVE.email });
    expect(await ask(BOB.email)).toMatchObject({ status: 201, body: { asked: [{ email: OLIVE.email }] } });
    expect(cards(ADA.email)).toEqual([]);
    expect(requests.resolve(`inbox-${OLIVE.email}`, cards(OLIVE.email)[0]!.card!.requestId!, "answer", "Not now")).toMatchObject({ body: { outcome: "declined" } });
    expect(writes).toEqual([]);
    expect(requests.resolve(`inbox-${OLIVE.email}`, "some-other-card", "answer", "Allow")).toBeNull();
  });

  it("refuses an ask from someone who can already chat", async () => {
    const { ask } = fixture({});
    expect((await ask(ADA.email)).status).toBe(409);
  });
});
