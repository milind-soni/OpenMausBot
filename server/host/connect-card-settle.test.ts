import { describe, expect, it } from "vitest";

import type { ConnectorCardData } from "../../shared/connector-card.ts";
import type { WireMessage as Message } from "../../shared/wire.ts";
import { createConnectCardSettle, settleOpenConnectCards } from "./connect-card-settle.ts";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const card = (id: string, connector: Partial<ConnectorCardData>): Message => ({
  id, role: "bot", kind: "connector", text: "", at: NOW,
  connector: { slug: "instagram", label: "Instagram", description: "", status: "required", resumeKey: `key-${id}`, ...connector },
} as Message);

function harness(threads: Record<string, Message[]>) {
  const resumed: Array<[string, string]> = [];
  const deps = {
    threadsWithCards: () => Object.keys(threads),
    messagesFor: (threadId: string) => threads[threadId] ?? [],
    patchMessage: (threadId: string, messageId: string, patch: Partial<Message>) => {
      const list = threads[threadId]!;
      const at = list.findIndex((message) => message.id === messageId);
      list[at] = { ...list[at]!, ...patch };
    },
    resume: (threadId: string, resumeKey: string) => { resumed.push([threadId, resumeKey]); },
    now: () => NOW,
  };
  const status = (threadId: string, id: string) => threads[threadId]!.find((message) => message.id === id)!.connector!.status;
  return { deps, resumed, status };
}

describe("reconnecting an app settles older open connect cards for it", () => {
  it("marks an older run's open card for the same app connected and lets its parked work carry on", () => {
    const h = harness({ "old-run": [card("a", { status: "authorizing" })], "other-app": [card("b", { slug: "gmail", label: "Gmail" })] });
    expect(settleOpenConnectCards(h.deps, "Instagram")).toBe(1);
    expect(h.status("old-run", "a")).toBe("connected");
    expect(h.status("other-app", "b")).toBe("required");
    expect(h.resumed).toEqual([["old-run", "key-a"]]);
  });

  it("only settles cards for that same account", () => {
    const h = harness({ t: [card("work", { alias: "Work" }), card("plain", {}), card("home", { alias: "home" })] });
    expect(settleOpenConnectCards(h.deps, "instagram", " work ")).toBe(1);
    expect([h.status("t", "work"), h.status("t", "plain"), h.status("t", "home")]).toEqual(["connected", "required", "required"]);
  });

  it("leaves cards the person closed, stopped or already finished, and MCP sign-in cards", () => {
    const h = harness({ t: [
      card("dismissed", { dismissed: true }), card("superseded", { superseded: true }), card("stopped", { stopped: true }),
      card("resumed", { resumed: true }), card("mcp", { source: "mcp" }), card("done", { status: "connected" }),
    ] });
    expect(settleOpenConnectCards(h.deps, "instagram")).toBe(0);
    expect(h.resumed).toEqual([]);
  });

  it("resumes each request once even when it had several cards for the app", () => {
    const h = harness({ t: [card("one", { resumeKey: "k" }), card("two", { resumeKey: "k", status: "failed", error: "Connection expired" })] });
    expect(settleOpenConnectCards(h.deps, "instagram")).toBe(2);
    expect(h.resumed).toEqual([["t", "k"]]);
  });

  it("settles from what Settings reads once an app or an account is active, and nothing for one still pending", () => {
    const h = harness({ t: [card("plain", {}), card("work", { alias: "work" }), card("gmail", { slug: "gmail", label: "Gmail" }), card("drive", { slug: "googledrive", label: "Drive" })] });
    createConnectCardSettle(h.deps).services({
      instagram: { connected: true, accounts: [{ alias: "work", status: "ACTIVE" }] },
      gmail: { connected: false, accounts: [{ status: "INITIATED" }] },
      googledrive: undefined,
    });
    expect(["plain", "work", "gmail", "drive"].map((id) => h.status("t", id))).toEqual(["connected", "connected", "required", "required"]);
  });
});
