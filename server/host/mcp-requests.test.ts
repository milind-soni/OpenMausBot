import { describe, expect, it, vi } from "vitest";

import type { McpChangeRequest, OptionCardData } from "../../shared/wire.ts";
import type { Store } from "../store.ts";
import { McpRequestService, type McpRequestOptions } from "./mcp-requests.ts";
import { closedByStop, resumableCards } from "./resumable-cards.ts";

const BOT = "kiwi";
const THREAD = "thread-1";

type Row = { id: string; at: number; role: "bot"; kind: "options"; card: OptionCardData; from?: { botId: string; name: string; color: string } };

function cardStore() {
  const rows: Row[] = [];
  return {
    rows,
    messagesFor: (threadId: string) => (threadId === THREAD ? rows : []),
    activePath: (threadId: string) => (threadId === THREAD ? rows : []),
    appendMessage(_threadId: string, message: Omit<Row, "id" | "at">) {
      const row = { ...message, id: `m${rows.length + 1}`, at: rows.length + 1 };
      rows.push(row);
      return row;
    },
    patchMessage(_threadId: string, messageId: string, patch: { card: OptionCardData }) {
      const row = rows.find((item) => item.id === messageId);
      if (row) row.card = patch.card;
    },
  };
}

function service(options: Partial<McpRequestOptions> & { store?: ReturnType<typeof cardStore> } = {}) {
  const store = options.store ?? cardStore();
  const apply = vi.fn(options.apply ?? (async (): Promise<NonNullable<McpChangeRequest["result"]>> => ({ state: "applied", text: "Turned on MCP server linear. Test: it works. Its tools: list_issues." })));
  const answers: string[] = [];
  let parked = true;
  const decisions: Array<{ decision: string }> = [];
  const cards = new McpRequestService({
    store, apply, teamCloud: options.teamCloud ?? false,
    answer: (_threadId, _messageId, text) => { answers.push(text); return parked; },
    decide: (row) => { decisions.push(row); },
  });
  const propose = () => cards.propose({ botId: BOT, threadId: THREAD, action: "enable", name: "linear" }, "https://mcp.linear.app/mcp");
  const respond = (requestId: string, behavior: "allow" | "deny", ownerReview = true) =>
    cards.respond({ botId: BOT, threadId: THREAD, requestId, behavior }, ownerReview);
  const waiting = () => resumableCards(store as unknown as Pick<Store, "activePath">, THREAD, 0);
  return { store, cards, apply, answers, decisions, propose, respond, waiting, noTurnParked: () => { parked = false; } };
}

describe("MCP approval cards", () => {
  it("allow without ownerReview is refused with 403", async () => {
    const local = service();
    const { requestId } = local.propose();
    expect(await local.respond(requestId, "allow", false)).toMatchObject({ status: 403 });
    expect(local.apply).not.toHaveBeenCalled();
    expect(local.store.rows[0]!.card).not.toHaveProperty("answered");

    const team = service({ teamCloud: true });
    const proposed = team.propose();
    expect(await team.respond(proposed.requestId, "allow", false)).toEqual({ status: 403, body: { error: "Ask a workspace admin to approve this." } });
    expect(team.apply).not.toHaveBeenCalled();
    expect(await team.respond(proposed.requestId, "deny", false)).toMatchObject({ status: 200, body: { alreadySettled: false } });
    expect(team.store.rows[0]!.card).toMatchObject({ answered: "deny" });
  });

  it("a newer card about the same server supersedes the open one, which can no longer be allowed", async () => {
    const { store, propose, respond, apply, waiting } = service();
    const older = propose();
    const newer = propose();
    expect(store.rows[0]!.card).toMatchObject({ expired: true, options: [] });
    expect(waiting().map((card) => card.id)).toEqual([newer.messageId]);
    expect(await respond(older.requestId, "allow")).toMatchObject({ body: { alreadySettled: true } });
    expect(apply).not.toHaveBeenCalled();
    expect(await respond(newer.requestId, "allow")).toMatchObject({ body: { alreadySettled: false, result: { state: "applied" } } });
    expect(apply).toHaveBeenCalledOnce();
  });

  it("stopCards closes an open mcpRequest card", async () => {
    const { store, propose, respond, apply, answers, waiting } = service();
    const { requestId } = propose();
    expect(waiting()).toHaveLength(1);
    const closed = closedByStop(store.rows[0]!.card);
    expect(closed).toMatchObject({ dismissed: true });
    store.patchMessage(THREAD, store.rows[0]!.id, { card: closed! });
    expect(closedByStop(store.rows[0]!.card), "an already closed card stays as it is").toBeNull();

    expect(await respond(requestId, "allow")).toMatchObject({ status: 200, body: { alreadySettled: true } });
    expect(apply).not.toHaveBeenCalled();
    expect(answers).toEqual([]);
    expect(waiting()).toEqual([]);
  });

  it("a restart reconciles a parked mcpRequest card", async () => {
    const before = service();
    const { requestId, messageId } = before.propose();
    before.noTurnParked();
    await before.respond(requestId, "allow");
    expect(before.store.rows[0]!.card.mcpRequest).toMatchObject({ result: { state: "applied" } });
    expect(before.store.rows[0]!.card.mcpRequest?.resumed).toBeUndefined();
    expect(before.waiting(), "the turn still waits for the decision").toHaveLength(1);

    const after = service({ store: before.store });
    const parked: string[] = [];
    expect(after.cards.resume(THREAD, messageId, (text) => { parked.push(text); return true; })).toBe(true);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toContain("Its tools: list_issues.");
    expect(after.store.rows[0]!.card.mcpRequest).toMatchObject({ resumed: true });
    expect(after.waiting()).toEqual([]);
    expect(after.apply, "the restart applies nothing again").not.toHaveBeenCalled();
  });
});
