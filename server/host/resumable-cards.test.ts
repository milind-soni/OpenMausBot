import { describe, expect, it } from "vitest";

import type { ConnectorCardData } from "../../shared/connector-card.ts";
import type { McpChangeRequest } from "../../shared/mcp-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import type { Store } from "../store.ts";
import { anyCardLive, resumableCards } from "./resumable-cards.ts";

const request: McpChangeRequest = { requestId: "r1", botId: "kiwi", threadId: "t1", action: "enable", name: "linear", targetHash: "0".repeat(64) };
const card = (extra: Partial<OptionCardData> = {}, mcp: Partial<McpChangeRequest> = {}): OptionCardData => ({
  title: "Turn on linear?", subtitle: "https://mcp.linear.app/mcp", options: ["Turn on", "Cancel"], requestId: "r1", tool: "mcp_server",
  ...extra, mcpRequest: { ...request, ...mcp },
});
const waitsOn = (one: OptionCardData) =>
  resumableCards({ activePath: () => [{ id: "m1", at: 10, role: "bot", kind: "options", card: one }] } as unknown as Pick<Store, "activePath">, "t1", 0);

describe("resumableCards", () => {
  it("resumableCards waits on an open mcpRequest card", () => {
    expect(waitsOn(card())).toEqual([{ id: "m1", waits: "MCP server decision: Turn on linear?" }]);
    expect(waitsOn(card({ answered: "allow" }, { result: { state: "applied", text: "Turned on." } })), "answered, not yet handed to the turn").toHaveLength(1);
    expect(waitsOn(card({ answered: "allow" }, { result: { state: "applied", text: "Turned on." }, resumed: true }))).toEqual([]);
    expect(waitsOn(card({ answered: "unavailable", dismissed: true })), "closed by Stop").toEqual([]);
    expect(waitsOn(card({ expired: true, options: [] })), "superseded").toEqual([]);
  });

  it("waits on an MCP Sign in card the person set aside until the bot hears it, never on one a newer card replaced", () => {
    const signIn = (extra: Partial<ConnectorCardData>) => resumableCards({ activePath: () => [{ id: "m2", at: 10, role: "bot", kind: "connector",
      connector: { source: "mcp", slug: "linear", label: "Linear", description: "", status: "required", resumeKey: "mcp-1", ...extra } }] } as unknown as Pick<Store, "activePath">, "t1", 0);
    expect(signIn({})).toEqual([{ id: "m2", waits: "connect Linear" }]);
    expect(signIn({ dismissed: true }), "Not now before the turn parked").toEqual([{ id: "m2", waits: "connect Linear" }]);
    expect(signIn({ dismissed: true, resumed: true })).toEqual([]);
    expect(signIn({ dismissed: true, superseded: true }), "a newer card for the same server").toEqual([]);
    const app = resumableCards({ activePath: () => [{ id: "m3", at: 10, role: "bot", kind: "connector",
      connector: { slug: "gmail", label: "Gmail", description: "", status: "required", resumeKey: "k-1", dismissed: true } }] } as unknown as Pick<Store, "activePath">, "t1", 0);
    expect(app, "an app's card set aside waits on nothing, as before").toEqual([]);
  });

  const secret = (extra: Record<string, unknown>) => ({ id: "s1", at: 10, role: "bot", kind: "secret", secret: { label: "Mailbox password", ...extra } });
  const signIn = (extra: Record<string, unknown>) => ({ id: "s2", at: 10, role: "bot", kind: "signin", signIn: { site: "example.com", ...extra } });
  const oneRow = (row: unknown) => ({ activePath: () => [row], messagesFor: () => [row] }) as unknown as Pick<Store, "activePath" | "messagesFor">;

  it("a stopped or replaced card waits on nobody, and a saved or declined one waits until the turn hears it", () => {
    expect(resumableCards(oneRow(secret({})), "t1", 0)).toEqual([{ id: "s1", waits: "provide Mailbox password" }]);
    expect(resumableCards(oneRow(secret({ provided: true })), "t1", 0), "saved, not yet heard").toHaveLength(1);
    expect(resumableCards(oneRow(secret({ dismissed: true })), "t1", 0), "declined, not yet heard").toHaveLength(1);
    expect(resumableCards(oneRow(secret({ provided: true, resumed: true })), "t1", 0)).toEqual([]);
    expect(resumableCards(oneRow(secret({ superseded: true })), "t1", 0)).toEqual([]);
    expect(resumableCards(oneRow(secret({ stopped: true })), "t1", 0)).toEqual([]);
    expect(resumableCards(oneRow(signIn({ stopped: true })), "t1", 0)).toEqual([]);
    expect(resumableCards(oneRow(signIn({ superseded: true })), "t1", 0)).toEqual([]);
  });

  it("tells a parked turn with a card left to wait on from one with none", () => {
    expect(anyCardLive(oneRow(secret({})), "t1", ["s1"])).toBe(true);
    expect(anyCardLive(oneRow(secret({ superseded: true })), "t1", ["s1"])).toBe(false);
    expect(anyCardLive(oneRow(secret({ stopped: true })), "t1", ["s1"])).toBe(false);
    expect(anyCardLive(oneRow(secret({})), "t1", ["gone"]), "a card that no longer exists").toBe(false);
  });
});
