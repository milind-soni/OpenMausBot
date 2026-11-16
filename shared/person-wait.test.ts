import { describe, expect, it } from "vitest";

import { openPersonWait, personWait, restingOnPerson, staysInView } from "./person-wait.ts";
import type { WireMessage } from "./wire.ts";

const row = (fields: Partial<WireMessage>): WireMessage => ({ id: "m", role: "bot", kind: "text", at: 5, ...fields }) as WireMessage;
const secret = (fields = {}) => row({ kind: "secret", secret: { target: "customSecret", label: "Mailbox password", description: "", placeholder: "", helpUrl: "", requestKey: "k", ...fields } as WireMessage["secret"] });
const signIn = (fields = {}) => row({ kind: "signin", signIn: { url: "https://example.com", site: "example.com", place: "browser", ...fields } as WireMessage["signIn"] });
const connector = (fields = {}) => row({ kind: "connector", connector: { slug: "gmail", label: "Gmail", description: "", status: "required", resumeKey: "k", ...fields } as WireMessage["connector"] });
const options = (fields = {}) => row({ kind: "options", card: { title: "t", options: ["a"], requestId: "r", ...fields } as WireMessage["card"] });

describe("what a row waits on the person for", () => {
  it("names the password, sign-in, connection, question, approval and proposal it waits on", () => {
    expect(personWait(secret())).toMatchObject({ kind: "password", label: "Mailbox password", messageId: "m", at: 5 });
    expect(personWait(signIn())).toMatchObject({ kind: "sign-in", label: "example.com" });
    expect(personWait(connector())).toMatchObject({ kind: "connect", label: "Gmail" });
    expect(personWait(options({ subtitle: "Which day?" }))).toMatchObject({ kind: "question", label: "Which day?" });
    expect(personWait(options({ tool: "Bash", subtitle: "rm" }))).toMatchObject({ kind: "approval", tool: "Bash" });
    expect(personWait(options({ skillRequest: {} }))).toMatchObject({ kind: "review" });
  });

  it.each([
    ["a saved password", secret({ provided: true })],
    ["a declined password", secret({ dismissed: true })],
    ["a superseded password", secret({ superseded: true })],
    ["a resumed password", secret({ resumed: true })],
    ["a stopped password", secret({ stopped: true })],
    ["a finished sign-in", signIn({ done: true })],
    ["a cancelled sign-in", signIn({ cancelled: true })],
    ["a superseded sign-in", signIn({ superseded: true })],
    ["a sign-in answered in the chat", signIn({ answeredInChat: true })],
    ["a stopped sign-in", signIn({ stopped: true })],
    ["a connected app", connector({ status: "connected" })],
    ["a dismissed connection", connector({ dismissed: true })],
    ["a superseded connection", connector({ superseded: true })],
    ["a stopped connection", connector({ stopped: true })],
    ["the first hour's offer to connect", connector({ resumeKey: "first-hour-1" })],
    ["an answered question", options({ answered: "answer" })],
    ["a dismissed question", options({ dismissed: true })],
    ["an expired proposal", options({ skillRequest: {}, expired: true })],
    ["an offer to switch engines", options({ quotaSwitch: {} })],
    ["a receipt", options({ autoApplied: true })],
    ["an inbox's copy of a card asked elsewhere", { ...options(), inbox: { kind: "ask", from: { name: "Mira" } } } as WireMessage],
    ["plain text", row({ text: "hello" })],
  ])("%s waits on nobody", (_name, message) => {
    expect(personWait(message)).toBeNull();
  });
});

describe("a conversation's visible branch", () => {
  it("reads the newest open wait, past settled cards", () => {
    const older = { ...secret(), id: "older" };
    const newer = { ...signIn(), id: "newer" };
    const settled = { ...secret({ superseded: true }), id: "settled" };
    expect(openPersonWait([older, newer, settled, row({ id: "said" })])?.messageId).toBe("newer");
    expect(openPersonWait([settled])).toBeUndefined();
  });

  it("rests on the person only for a card that outlives its turn", () => {
    const approval = { ...options({ tool: "Bash" }), id: "approval" };
    const password = { ...secret(), id: "password" };
    expect(openPersonWait([password, approval])?.messageId).toBe("approval");
    expect(restingOnPerson([password, approval])?.messageId).toBe("password");
    expect(restingOnPerson([approval])).toBeUndefined();
  });
});

describe("cards that stay in view", () => {
  it("are an open key or app to connect, not a question, sign-in, or a settled or first-hour card", () => {
    expect(staysInView(secret())).toBe(true);
    expect(staysInView(connector())).toBe(true);
    expect(staysInView(secret({ dismissed: true }))).toBe(false);
    expect(staysInView(connector({ resumeKey: "first-hour-gmail" }))).toBe(false);
    expect(staysInView(signIn())).toBe(false);
    expect(staysInView(options({ subtitle: "Which day?" }))).toBe(false);
    expect(staysInView(row({}))).toBe(false);
  });
});

describe("a question the person wrote past", () => {
  const question = { ...options({ subtitle: "Which page?" }), id: "question" };
  const password = { ...secret(), id: "password" };
  const wrote = (fields: Partial<WireMessage> = {}) => row({ id: "said", role: "user", text: "Do the report instead", ...fields });

  it("no longer waits once the person writes after it, while cards that are not questions still do", () => {
    expect(restingOnPerson([question])?.messageId).toBe("question");
    expect(restingOnPerson([question, wrote()])).toBeUndefined();
    expect(restingOnPerson([password, question, wrote()])?.messageId).toBe("password");
    expect(restingOnPerson([wrote(), question])?.messageId).toBe("question");
  });

  it.each([
    ["another bot", { peerAsk: { botId: "scout", name: "Scout" } }],
    ["a relay", { relayed: true }],
    ["the API", { via: "api" as const }],
    ["an automation", { automated: true }],
  ])("still waits after a line %s wrote", (_name, fields) => {
    expect(restingOnPerson([question, wrote(fields)])?.messageId).toBe("question");
  });

  it("in a room, waits until the person replies to the question itself", () => {
    expect(restingOnPerson([question, wrote()], true)?.messageId).toBe("question");
    expect(restingOnPerson([question, wrote({ replyToId: "question" })], true)).toBeUndefined();
  });
});
