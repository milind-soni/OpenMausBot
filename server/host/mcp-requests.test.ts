import { describe, expect, it, vi } from "vitest";

import type { OptionCardData } from "../../shared/wire.ts";
import type { Store } from "../store.ts";
import { McpRequestService, type McpApplied, type McpRequestOptions } from "./mcp-requests.ts";
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
  const apply = vi.fn(options.apply ?? (async (): Promise<McpApplied> => ({ state: "applied", text: "Turned on MCP server linear. Test: it works. Its tools: list_issues." })));
  const answers: string[] = [];
  let parked = true;
  const decisions: Array<{ decision: string }> = [];
  const cards = new McpRequestService({
    store, apply, teamCloud: options.teamCloud ?? false,
    answer: (_threadId, _messageId, text) => { answers.push(text); return parked; },
    decide: (row) => { decisions.push(row); },
  });
  const propose = (action: "enable" | "update" = "enable") => cards.propose({ botId: BOT, threadId: THREAD, action, name: "linear", targetHash: "0".repeat(64) },
    "https://mcp.linear.app/mcp", action === "update" ? { resultBudget: 4000 } : undefined);
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

  it("a restart-then-allow on a Change card resumes with the expired text and applies nothing", async () => {
    const before = service();
    const { requestId } = before.propose("update");
    const after = service({ store: before.store });
    expect(await after.respond(requestId, "allow")).toMatchObject({ status: 200, body: { alreadySettled: false, result: { state: "expired" } } });
    expect(after.apply).not.toHaveBeenCalled();
    expect(after.answers).toHaveLength(1);
    expect(after.answers[0]).toContain("OpenMausBot restarted, so this request expired. Ask again if you still need it.");
    expect(after.store.rows[0]!.card).toMatchObject({ expired: true, options: [], held: "OpenMausBot restarted, so this request expired.", mcpRequest: { resumed: true } });
  });

  it("a restart expires an open Change card for the turn parked on it, which hears why, and leaves a Turn on card open", () => {
    const before = service();
    const { messageId } = before.propose("update");
    expect(before.cards.decided(THREAD, messageId), "the change is still held before a restart").toBe(false);
    const after = service({ store: before.store });
    expect(after.cards.decided(THREAD, messageId)).toBe(true);
    const parked: string[] = [];
    expect(after.cards.resume(THREAD, messageId, (text) => { parked.push(text); return true; })).toBe(true);
    expect(parked[0]).toContain("OpenMausBot restarted, so this request expired. Ask again if you still need it.");
    expect(after.waiting()).toEqual([]);

    const turnOn = service();
    const open = turnOn.propose("enable");
    const restarted = service({ store: turnOn.store });
    expect(restarted.cards.decided(THREAD, open.messageId), "a Turn on card holds no fields, so it waits for the person").toBe(false);
    expect(restarted.waiting().map((card) => card.id)).toEqual([open.messageId]);
  });

  it("a busy config answers 409 and leaves the card open for another try", async () => {
    let busy = true;
    const local = service({ apply: async () => (busy ? { state: "busy" } : { state: "applied", text: "Turned on MCP server linear." }) });
    const { requestId } = local.propose();
    expect(await local.respond(requestId, "allow")).toEqual({ status: 409, body: { error: "MCP servers are already being updated. Try again in a moment." } });
    expect(local.store.rows[0]!.card).not.toHaveProperty("answered");
    expect(local.store.rows[0]!.card).not.toHaveProperty("expired");
    expect(local.answers).toEqual([]);
    expect(local.decisions.map((row) => row.decision)).toEqual(["card-shown"]);
    busy = false;
    expect(await local.respond(requestId, "allow")).toMatchObject({ status: 200, body: { result: { state: "applied" } } });
  });

  it("an error from apply settles the card as failed, records the decision and resumes the bot with the error", async () => {
    const local = service({ apply: async () => { throw new Error("disk full"); } });
    const { requestId } = local.propose();
    expect(await local.respond(requestId, "allow")).toMatchObject({ status: 200, body: { result: { state: "failed" } } });
    expect(local.store.rows[0]!.card).toMatchObject({ expired: true, held: "This change couldn't be applied.", mcpRequest: { resumed: true } });
    expect(local.answers[0]).toContain("The person approved it, but it wasn't applied: disk full");
    expect(local.decisions.map((row) => row.decision)).toEqual(["card-shown", "user-approved"]);
  });

  it("a new card about the same server frees the held fields of every earlier one, a Stop-closed card's included", () => {
    const { store, cards, propose } = service();
    const stopped = propose("update");
    store.patchMessage(THREAD, stopped.messageId, { card: closedByStop(store.rows[0]!.card)! });
    const held = (cards as unknown as { held: Map<string, unknown> }).held;
    expect(held.has(stopped.requestId)).toBe(true);
    const newer = propose("update");
    expect([...held.keys()]).toEqual([newer.requestId]);
  });
});
