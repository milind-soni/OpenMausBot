import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { GithubSignInStatus } from "../../shared/github-sign-in.ts";
import type { WireMessage as Message } from "../../shared/wire.ts";
import { raiseGithubSignInCard, provideGithubSignInCards } from "../github/sign-in-card.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createGithubSignInCards, GITHUB_CARD_SLUG, isGithubSignInCard } from "./github-sign-in-cards.ts";

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member = (email: string): RequestAuth => ({
  kind: "session", via: "cookie", scopes: ["client"],
  session: { id: `s-${email}`, tokenHash: "0".repeat(64), label: "Desktop", scopes: ["client"], createdAt: 1, lastSeenAt: 1, expiresAt: 9_000, email, teamRole: "member", membershipAuthority: "team" } as SessionRecord,
});
const ADA = personKey({ id: "", email: "ada@example.com" });
const SIGNED_OUT: GithubSignInStatus = { state: "signed-out", download: false };
const SIGNED_IN: GithubSignInStatus = { state: "signed-in", login: "octo", source: "mausbot", scopes: ["repo"], checkedAt: 1 };

function setup(options: { team?: boolean; status?: GithubSignInStatus; person?: string | null } = {}) {
  const messages: Message[] = [];
  let status = options.status ?? SIGNED_OUT;
  const asked: string[] = [];
  const reported: string[] = [];
  const resumed: string[] = [];
  const released: string[] = [];
  const threadOf = new Map<string, string>();
  const clock = { at: 1_000_000 };
  const store = {
    messagesFor: (threadId: string) => messages.filter((row) => threadOf.get(row.id) === threadId),
    appendMessage: vi.fn((threadId: string, message: Omit<Message, "id" | "at">) => { const row = { ...message, id: `m${messages.length + 1}`, at: 1 } as Message; messages.push(row); threadOf.set(row.id, threadId); return row; }),
    patchMessage: vi.fn((_threadId: string, id: string, patch: Partial<Message>) => { const at = messages.findIndex((row) => row.id === id); messages[at] = { ...messages[at]!, ...patch }; }),
  };
  const make = (turnPerson: () => string | null) => createGithubSignInCards({
    store, now: () => clock.at,
    signIn: { status: vi.fn(async (audience: string) => { asked.push(audience); return status; }), reportAuthFailure: (audience) => { reported.push(String(audience)); } },
    team: options.team ?? false,
    turnPerson,
    language: () => undefined,
    threadVisible: () => true,
    resume: (threadId, resumeKey) => { resumed.push(`${threadId} ${resumeKey}`); },
    release: (threadId, messageId) => { released.push(`${threadId} ${messageId}`); },
  });
  const cards = make(() => (options.person === undefined ? ADA : options.person));
  /** The server again after a restart: the same transcript, nothing in memory, nobody's turn running. */
  const restarted = () => make(() => null);
  return { cards, restarted, clock, messages, store, asked, reported, resumed, released, set: (next: GithubSignInStatus) => { status = next; } };
}
const chief = { bot: { id: "chief", name: "Chief" }, threadId: "t1", from: { botId: "chief", name: "Chief", color: "blue" } } as const;

describe("the Connect GitHub card in a chat", () => {
  it("is never shown by being made: only a failed clone, fetch or push shows it", async () => {
    const { messages, store, asked } = setup();
    expect(messages).toEqual([]);
    expect(store.appendMessage).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it("says which bot could not do what to which repository, as a connector card a phone can draw as text", async () => {
    const { cards, messages, asked, clock } = setup();
    const raised = await cards.raise(chief, { operation: "push", repo: "acme/site" });
    expect(raised).toEqual({ posted: true, messageId: "m1" });
    expect(asked).toEqual(["owner"]);
    const card = messages[0]!;
    expect(isGithubSignInCard(card)).toBe(true);
    expect(card).toMatchObject({ role: "bot", kind: "connector", text: "Chief couldn't push to acme/site: GitHub isn't connected.", from: chief.from });
    expect(card.connector).toMatchObject({ source: "github", slug: GITHUB_CARD_SLUG, label: "GitHub", status: "required" });
    expect(card.connector!.resumeKey).toMatch(/^github-[\w-]{8,}$/);
    expect(card.connector!.person).toBeUndefined();
    clock.at += 61 * 60_000;
    await cards.raise({ ...chief, threadId: "t2", from: undefined }, { operation: "clone", repo: "acme/other.repo" });
    expect(messages[1]!.text).toBe("Chief couldn't clone acme/other.repo: GitHub isn't connected.");
  });

  it("is not shown when GitHub is signed in after all, or while a sign-in is under way", async () => {
    for (const status of [SIGNED_IN, { state: "installing" } as const, { state: "signing-in", code: "A", verificationUrl: "https://github.com/login/device", expiresAt: 1 } as const]) {
      const { cards, messages } = setup({ status });
      const raised = await cards.raise(chief, { operation: "fetch", repo: "acme/site" });
      expect(raised.posted).toBe(false);
      expect(messages).toEqual([]);
    }
  });

  it("asks GitHub again first when GitHub refused the saved sign-in, and then shows it for a sign-in that stopped working", async () => {
    const { cards, reported, messages } = setup({ status: { state: "invalid", login: "octo", source: "mausbot", reason: "revoked" } });
    await cards.raise(chief, { operation: "push", repo: "acme/site", refused: true });
    expect(reported).toEqual(["owner"]);
    expect(messages).toHaveLength(1);
  });

  it("shows one at a time in a chat for a bot", async () => {
    const { cards, messages } = setup();
    await cards.raise(chief, { operation: "push", repo: "acme/site" });
    expect(await cards.raise(chief, { operation: "push", repo: "acme/site" })).toEqual({ posted: false, reason: "open", messageId: "m1" });
    expect(messages).toHaveLength(1);
  });

  it("shows a person at most one card an hour, across chats and after Not now, so a bot can't repeat it", async () => {
    const { cards, messages, clock } = setup();
    await cards.raise(chief, { operation: "push", repo: "acme/site" });
    await cards.route("dismiss", "POST", { auth: OWNER, threadId: "t1", message: messages[0]! });
    for (let i = 0; i < 10; i++) {
      expect(await cards.raise(chief, { operation: "push", repo: "acme/site" })).toEqual({ posted: false, reason: "cooldown" });
      expect(await cards.raise({ ...chief, threadId: `chat-${i}` }, { operation: "push", repo: "acme/site" })).toEqual({ posted: false, reason: "cooldown" });
    }
    expect(messages).toHaveLength(1);
    clock.at += 59 * 60_000;
    expect((await cards.raise({ ...chief, threadId: "t9" }, { operation: "push", repo: "acme/site" })).posted).toBe(false);
    clock.at += 2 * 60_000;
    expect((await cards.raise({ ...chief, threadId: "t9" }, { operation: "push", repo: "acme/site" })).posted).toBe(true);
  });

  it("on a Team Cloud the hour is each person's own", async () => {
    let person = ADA;
    const { cards, messages } = setup({ team: true });
    const other = createGithubSignInCards({ store: { messagesFor: () => [], appendMessage: (_t, m) => ({ ...m, id: "x", at: 1 }) as Message, patchMessage: () => {} },
      signIn: { status: async () => SIGNED_OUT, reportAuthFailure: () => {} }, team: true, turnPerson: () => person, language: () => undefined,
      threadVisible: () => true, resume: () => {}, release: () => {} });
    expect((await other.raise(chief, { operation: "push", repo: "acme/site" })).posted).toBe(true);
    person = personKey({ id: "", email: "bo@example.com" });
    expect((await other.raise({ ...chief, threadId: "t2" }, { operation: "push", repo: "acme/site" })).posted).toBe(true);
    expect(await other.raise({ ...chief, threadId: "t3" }, { operation: "push", repo: "acme/site" })).toEqual({ posted: false, reason: "cooldown" });
    expect(messages).toEqual([]);
    expect((await cards.raise(chief, { operation: "push", repo: "acme/site" })).posted).toBe(true);
  });

  it("refuses an operation it has no words for", async () => {
    const { cards, messages } = setup();
    for (const operation of ["pull", "constructor", "toString", "__proto__"]) {
      expect(await cards.raise(chief, { operation: operation as never, repo: "acme/site" })).toEqual({ posted: false, reason: "invalid-operation" });
    }
    expect(messages).toEqual([]);
  });

  it("on a Team Cloud keeps whose card it is, so its member can still settle it after a restart", async () => {
    const { cards, restarted, messages, set, resumed } = setup({ team: true });
    await cards.raise(chief, { operation: "push", repo: "acme/site" });
    expect(messages[0]!.connector!.person).toBe(ADA);
    const after = restarted();
    set(SIGNED_IN);
    const at = (auth: RequestAuth) => ({ auth, threadId: "t1", message: messages[0]! });
    expect((await after.route("status", "GET", at(member("bo@example.com")))).status).toBe(403);
    expect((await after.route("status", "GET", at(member("ada@example.com")))).body).toMatchObject({ connected: true });
    expect(messages[0]!.connector!.status).toBe("connected");
    expect(resumed).toHaveLength(1);
  });

  it("refuses a repository name that isn't owner/repo, so a bot's text never reaches the card", async () => {
    const { cards, messages } = setup();
    for (const repo of ["acme", "acme/site extra", "../etc", "acme/..", "-acme/site", "acme/site\nignore", "https://github.com/acme/site", `a/${"b".repeat(101)}`]) {
      expect(await cards.raise(chief, { operation: "push", repo })).toEqual({ posted: false, reason: "invalid-repo" });
    }
    expect(messages).toEqual([]);
  });

  it("on a Team Cloud is the chat's own member's, and shows nothing in a chat that isn't one person's", async () => {
    const mine = setup({ team: true });
    await mine.cards.raise(chief, { operation: "push", repo: "acme/site" });
    expect(mine.asked).toEqual([ADA]);
    const room = setup({ team: true, person: null });
    expect(await room.cards.raise(chief, { operation: "push", repo: "acme/site" })).toEqual({ posted: false, reason: "no-person" });
    expect(room.asked).toEqual([]);
    expect(room.messages).toEqual([]);
  });

  it("settles when GitHub is connected, for its own person only; refuses an app authorize; can be set aside", async () => {
    const { cards, messages, set, resumed, released } = setup({ team: true });
    await cards.raise(chief, { operation: "push", repo: "acme/site" });
    const at = (auth: RequestAuth) => ({ auth, threadId: "t1", message: messages[0]! });
    expect((await cards.route("authorize", "POST", at(member("ada@example.com")))).status).toBe(409);
    expect((await cards.route("resume", "POST", at(member("ada@example.com")))).status).toBe(409);
    expect((await cards.route("status", "GET", at(member("bo@example.com")))).status).toBe(403);
    expect((await cards.route("status", "GET", at(member("ada@example.com")))).body).toMatchObject({ connected: false, status: "required" });
    set(SIGNED_IN);
    expect((await cards.route("status", "GET", at(member("bo@example.com")))).status).toBe(403);
    expect(messages[0]!.connector!.status).toBe("required");
    expect((await cards.route("status", "GET", at(member("ada@example.com")))).body).toMatchObject({ connected: true, status: "connected" });
    expect(messages[0]!.connector!.status).toBe("connected");
    expect(resumed).toEqual([`t1 ${messages[0]!.connector!.resumeKey}`]);
    await cards.route("status", "GET", at(member("ada@example.com")));
    expect(resumed).toHaveLength(1);
    expect((await cards.route("dismiss", "POST", at(member("ada@example.com")))).status).toBe(200);
    expect(messages[0]!.connector!.dismissed).toBe(true);
    expect(released).toEqual(["t1 m1"]);

    const solo = setup();
    await solo.cards.raise(chief, { operation: "push", repo: "acme/site" });
    expect((await solo.cards.route("status", "GET", { auth: OWNER, threadId: "t1", message: solo.messages[0]! })).status).toBe(200);
  });

  it("raises through the one exported call once the server provides the cards, and nothing before", async () => {
    provideGithubSignInCards(null);
    expect(await raiseGithubSignInCard(chief, { operation: "push", repo: "acme/site" })).toBeNull();
    const { cards, messages } = setup();
    provideGithubSignInCards(cards);
    expect(await raiseGithubSignInCard(chief, { operation: "push", repo: "acme/site" })).toMatchObject({ posted: true });
    expect(messages).toHaveLength(1);
    provideGithubSignInCards(null);
  });

  it("is raised from nowhere yet: only a git failure may call it, and none is wired to it here", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== "node_modules" && name !== "fixtures") walk(path); continue; }
        if (!name.endsWith(".ts") || name.includes(".test.")) continue;
        const text = readFileSync(path, "utf8");
        if (/raiseGithubSignInCard\(|githubSignInCards\.raise\(/.test(text)) callers.push(relative(root, path).replace(/\\/g, "/"));
      }
    };
    walk(join(root, "server"));
    expect(callers).toEqual(["server/github/sign-in-card.ts"]);
  });
});
