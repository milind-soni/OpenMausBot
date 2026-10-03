import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MAX_MCP_SERVERS } from "./mcp-registry.ts";
import {
  McpServerRequestError,
  McpServerRequestService,
  mcpServerRevision,
  type McpServerCommit,
  type McpServerRequestServiceOptions,
  type McpServerRequestStore,
  type OptionCardLike,
} from "./mcp-server-requests.ts";

interface StoredMessage {
  id: string;
  card?: OptionCardLike;
}

class MemoryStore implements McpServerRequestStore {
  readonly threads = new Map<string, StoredMessage[]>();
  failNextPatch = false;
  private sequence = 0;

  messagesFor(threadId: string): StoredMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: OptionCardLike }): StoredMessage {
    const stored: StoredMessage = { id: `message-${++this.sequence}`, card: structuredClone(message.card) };
    this.threads.set(threadId, [...this.messagesFor(threadId), stored]);
    return stored;
  }

  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): StoredMessage | null {
    if (this.failNextPatch) {
      this.failNextPatch = false;
      throw new Error("disk full");
    }
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = structuredClone(patch.card);
    return message;
  }
}

const SECRET = "notes-secret-value-that-must-never-render";
const HEADER_SECRET = "Bearer header-secret-that-must-never-render";
const CLIENT_SECRET = "client-secret-that-must-never-render";
const BOT = "chief";
const THREAD = "thread-1";

function harness(overrides: Partial<McpServerRequestServiceOptions> = {}) {
  const store = new MemoryStore();
  const config: { servers: Record<string, unknown> } = { servers: {} };
  const commits: McpServerCommit[] = [];
  const options: McpServerRequestServiceOptions = {
    store,
    servers: () => config.servers,
    commit: (next, change) => {
      commits.push(change);
      config.servers = next;
    },
    ...overrides,
  };
  const service = new McpServerRequestService(options);
  const propose = (request: Record<string, unknown>) => service.propose({ botId: BOT, threadId: THREAD, request });
  const resolve = (requestId: string, behavior = "allow", using = service) => using.resolve({ botId: BOT, threadId: THREAD, requestId, behavior });
  const card = (requestId: string) => store.messagesFor(THREAD).find((message) => message.card?.requestId === requestId)!.card!;
  return { store, config, commits, service, options, propose, resolve, card };
}

const notes = (enabled = false) => ({ command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: SECRET }, enabled });
const docs = (enabled = false) => ({
  type: "http", url: "https://docs.example/mcp", headers: { Authorization: HEADER_SECRET },
  oauth: { clientId: "corp-app", clientSecret: CLIENT_SECRET, scopes: ["offline_access"] }, enabled,
});

function expectError(run: () => unknown, pattern: RegExp, status?: number) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpServerRequestError);
    expect((error as Error).message).toMatch(pattern);
    if (status !== undefined) expect((error as McpServerRequestError).status).toBe(status);
    return error as McpServerRequestError;
  }
  throw new Error(`expected a refusal matching ${pattern}`);
}

describe("McpServerRequestService", () => {
  it("proposes an add as a card that names the command and its env keys, then files it switched off", () => {
    const { propose, resolve, card, config, commits } = harness();
    const proposal = propose({
      action: "add", name: "notes", command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: SECRET }, reason: "The user asked for their notes.",
    });
    expect(proposal.title).toBe("Add MCP server “notes”?");
    expect(proposal.detail.split("\n")).toEqual([
      "Why: The user asked for their notes.",
      "Server: notes",
      "Transport: local command",
      'Command: "npx"',
      'Arguments: "-y" "notes-mcp"',
      "Environment names: NOTES_TOKEN",
      "Saved switched off. Nothing runs.",
    ]);
    const pending = card(proposal.requestId);
    expect(pending).toMatchObject({ options: ["Confirm", "Cancel"], tool: "propose_mcp_server" });
    expect(pending.mcpServerRequest).toMatchObject({
      action: "add", name: "notes", heldSecrets: true, expectedRevision: "absent",
      suppliedSecrets: { env: ["NOTES_TOKEN"], headers: [], clientSecret: false },
      after: { transport: "command", command: "npx", args: ["-y", "notes-mcp"], envNames: ["NOTES_TOKEN"], enabled: false },
    });
    expect(config.servers).toEqual({});

    expect(resolve(proposal.requestId)).toEqual({ claimed: true, state: "applied", action: "add", name: "notes" });
    expect(config.servers).toEqual({ notes: notes(false) });
    expect(commits).toEqual([{ action: "add", name: "notes", before: undefined, after: notes(false) }]);
    expect(card(proposal.requestId)).toMatchObject({ answered: "allow" });
  });

  it("shows a url server's transport, address, header names and sign-in app without any secret value", () => {
    const { propose, resolve, config } = harness();
    const proposal = propose({
      action: "add", name: "docs", url: "https://docs.example/mcp", type: "sse",
      headers: { Authorization: HEADER_SECRET }, oauth: { clientId: "corp-app", clientSecret: CLIENT_SECRET, scopes: ["offline_access"] },
      reason: "The user wants the docs server.",
    });
    expect(proposal.detail).toContain("Transport: sse");
    expect(proposal.detail).toContain('URL: "https://docs.example/mcp"');
    expect(proposal.detail).toContain("Header names: Authorization");
    expect(proposal.detail).toContain('Sign-in client ID: "corp-app"');
    expect(proposal.detail).toContain("Sign-in scopes: offline_access");
    expect(proposal.detail).toContain("Client secret supplied: yes");
    expect(resolve(proposal.requestId).state).toBe("applied");
    expect(config.servers.docs).toEqual({ ...docs(false), type: "sse" });
  });

  it("coerces what has one obvious meaning: case, aliases, and stringified objects", () => {
    const { propose, card } = harness();
    const proposal = propose({
      action: " Create ", name: "Notes", command: "npx", args: '["-y","notes-mcp"]', env: `{"NOTES_TOKEN":"${SECRET}","PORT":8080}`,
      reason: "Asked.",
    });
    expect(card(proposal.requestId).mcpServerRequest).toMatchObject({
      action: "add", name: "notes", after: { args: ["-y", "notes-mcp"], envNames: ["NOTES_TOKEN", "PORT"] },
    });
  });

  it("refuses malformed proposals with a sentence and a literal example to copy", () => {
    const { propose, config } = harness();
    config.servers = { notes: notes(false) };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "notes", reason: "x" }, /action must be add, update, enable, disable, or remove/],
      [{ action: "launch", name: "notes", reason: "x" }, /action must be/],
      [{ action: "add", name: "notes", command: "npx", enabled: true, reason: "x" }, /no enabled field.*"enable" or "disable"/],
      [{ action: "add", name: "Bad Name!", command: "npx", reason: "x" }, /Use 1–32 lowercase letters/],
      [{ action: "add", name: "other", command: "npx", reason: " " }, /reason is required/],
      [{ action: "add", name: "other", reason: "x" }, /An add needs command .* or url/],
      [{ action: "add", name: "other", command: "npx", url: "https://a.example", reason: "x" }, /not both/],
      [{ action: "add", name: "other", command: "npx", headers: { A: "b" }, reason: "x" }, /headers only apply to a server reached by url/],
      [{ action: "add", name: "other", command: "npx", args: "-y notes", reason: "x" }, /args must be a list of strings, like \["-y","notes-mcp"\]/],
      [{ action: "add", name: "other", command: "npx", env: "TOKEN", reason: "x" }, /env must be an object of names to string values/],
      [{ action: "enable", name: "notes", command: "npx", reason: "x" }, /enable takes only name and reason/],
      [{ action: "update", name: "notes", reason: "x" }, /An update needs at least one of/],
      [{ action: "add", name: "notes", command: "npx", reason: "x" }, /already exists\. Use action "update"/],
      [{ action: "enable", name: "missing", reason: "x" }, /No MCP server named “missing” exists/],
      [{ action: "add", name: "other", url: "ftp://a.example", reason: "x" }, /must start with http/],
      [{ action: "add", name: "other", command: "npx", wat: 1, reason: "x" }, /Unsupported field: wat/],
    ];
    for (const [request, pattern] of cases) {
      const error = expectError(() => propose(request), pattern);
      expect(error.message, JSON.stringify(request)).toMatch(/Example: \{"action":/);
    }
  });

  it("refuses an env name reserved by the harness, as the settings form does", () => {
    const { propose } = harness();
    for (const name of ["OMB_COMMS_TOKEN", "OGB_TOKEN", "ELECTRON_RUN_AS_NODE"]) {
      const error = expectError(() => propose({ action: "add", name: "notes", command: "npx", env: { [name]: SECRET }, reason: "x" }), /reserved by OpenMausBot/, 400);
      expect(error.message).not.toContain(SECRET);
    }
  });

  it("refuses an add past the server limit at propose, and re-checks the limit at confirm", () => {
    const { propose, resolve, card, config } = harness();
    const full = Object.fromEntries(Array.from({ length: MAX_MCP_SERVERS }, (_, i) => [`s${i}`, { command: "x", enabled: false }]));
    config.servers = full;
    expectError(() => propose({ action: "add", name: "notes", command: "npx", reason: "x" }), /at most 20 MCP servers/, 409);

    const { s0: _removed, ...room } = full;
    config.servers = room;
    const proposal = propose({ action: "add", name: "notes", command: "npx", reason: "x" });
    config.servers = { ...room, s0: { command: "x", enabled: false } };
    expect(resolve(proposal.requestId)).toMatchObject({ state: "invalid", status: 409, error: expect.stringMatching(/at most 20/) });
    // Freeing a slot is something the user can do, so the card stays actionable.
    expect(card(proposal.requestId)).toMatchObject({ options: ["Confirm", "Cancel"] });
    expect(card(proposal.requestId).expired).toBeUndefined();
    config.servers = room;
    expect(resolve(proposal.requestId).state).toBe("applied");
    expect(Object.keys(config.servers)).toHaveLength(MAX_MCP_SERVERS);
  });

  it("applies the organisation's policy at propose and again at confirm", () => {
    let refusal: string | null = "Your organisation has not approved notes.";
    const { propose, resolve, card, config } = harness({ policyRefusal: () => refusal });
    expectError(() => propose({ action: "add", name: "notes", command: "npx", reason: "x" }), /not approved notes/, 403);
    refusal = null;
    const proposal = propose({ action: "add", name: "notes", command: "npx", reason: "x" });
    refusal = "Your organisation has not approved notes.";
    expect(resolve(proposal.requestId)).toMatchObject({ state: "invalid", status: 403 });
    expect(card(proposal.requestId)).toMatchObject({ expired: true, options: [] });
    expect(config.servers).toEqual({});
  });

  it("merges an update with the saved entry, so saved secrets survive without being resent", () => {
    const { propose, resolve, card, config, commits } = harness();
    config.servers = { notes: notes(false), docs: docs(false) };
    const local = propose({ action: "update", name: "notes", args: ["-y", "notes-mcp@2"], env: { REGION: "eu" }, reason: "Newer version." });
    expect(local.title).toBe("Change MCP server “notes”?");
    expect(local.detail.split("\n")).toEqual([
      "Why: Newer version.",
      "Server: notes",
      'Arguments: "-y" "notes-mcp" → "-y" "notes-mcp@2"',
      "Environment names: NOTES_TOKEN → NOTES_TOKEN, REGION",
      "New secret values supplied for: environment REGION",
      "It stays switched off. Nothing runs.",
    ]);
    expect(resolve(local.requestId).state).toBe("applied");
    expect(config.servers.notes).toEqual({ command: "npx", args: ["-y", "notes-mcp@2"], env: { NOTES_TOKEN: SECRET, REGION: "eu" }, enabled: false });

    const remote = propose({ action: "update", name: "docs", url: "https://docs.example/v2/mcp", reason: "It moved." });
    expect(remote.detail).toContain('URL: "https://docs.example/mcp" → "https://docs.example/v2/mcp"');
    expect(remote.detail).not.toContain("Header names");
    expect(resolve(remote.requestId).state).toBe("applied");
    expect(config.servers.docs).toEqual({ ...docs(false), url: "https://docs.example/v2/mcp" });
    expect(commits.at(-1)).toMatchObject({ action: "update", name: "docs", before: { url: "https://docs.example/mcp" }, after: { url: "https://docs.example/v2/mcp" } });
    expect(JSON.stringify(card(remote.requestId))).not.toContain(CLIENT_SECRET);
  });

  it("drops the old kind's fields when an update switches between a command and a url", () => {
    const { propose, resolve, config } = harness();
    config.servers = { notes: notes(false) };
    const proposal = propose({ action: "update", name: "notes", url: "https://notes.example/mcp", reason: "Hosted now." });
    expect(proposal.detail).toContain("Transport: local command → http");
    expect(proposal.detail).toContain('Command: "npx" → none');
    expect(resolve(proposal.requestId).state).toBe("applied");
    expect(config.servers.notes).toEqual({ type: "http", url: "https://notes.example/mcp", headers: {}, enabled: false });
  });

  describe("revisions on the card", () => {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
        : value;
    const unmaskedHash = (entry: unknown) => createHash("sha256").update(JSON.stringify(canonical(entry)), "utf8").digest("hex");

    it("are the same for entries that differ only in a secret value, and never hash a secret", () => {
      const payloads = [SECRET, "x"].map((value) => {
        const { propose, card, config } = harness();
        config.servers = {
          notes: { ...notes(false), env: { NOTES_TOKEN: value } },
          docs: { ...docs(false), headers: { Authorization: value }, oauth: { ...docs(false).oauth, clientSecret: value } },
        };
        return ["notes", "docs"].map((name) => card(propose({ action: "enable", name, reason: "x" }).requestId).mcpServerRequest!);
      });
      for (const index of [0, 1]) {
        expect(payloads[0]![index]!.expectedRevision).toBe(payloads[1]![index]!.expectedRevision);
        expect(payloads[0]![index]!.appliedRevision).toBe(payloads[1]![index]!.appliedRevision);
      }
      const unmasked = [notes(false), notes(true), docs(false), docs(true)].map(unmaskedHash);
      for (const payload of payloads.flat()) {
        expect(unmasked).not.toContain(payload.expectedRevision);
        expect(unmasked).not.toContain(payload.appliedRevision);
      }
      // Names still count: a new key is a new revision.
      expect(mcpServerRevision({ ...notes(false), env: { NOTES_TOKEN: SECRET, OTHER: "" } })).not.toBe(mcpServerRevision(notes(false)));
    });

    it("apply a secret-only update once, writing the new value", () => {
      const { store, propose, resolve, card, config, commits } = harness();
      config.servers = { notes: notes(false) };
      const rotated = "rotated-secret-that-must-never-render";
      const proposal = propose({ action: "update", name: "notes", env: { NOTES_TOKEN: rotated }, reason: "The user rotated the token." });
      const payload = card(proposal.requestId).mcpServerRequest!;
      // The masked revision cannot tell the two values apart, so the
      // "already at appliedRevision" shortcut must not settle this card.
      expect(payload.appliedRevision).toBe(payload.expectedRevision);
      expect(proposal.detail).toContain("New secret values supplied for: environment NOTES_TOKEN");
      store.failNextPatch = true;
      expect(resolve(proposal.requestId)).toMatchObject({ state: "applied", settlementPending: true });
      expect(config.servers.notes).toEqual({ ...notes(false), env: { NOTES_TOKEN: rotated } });
      expect(resolve(proposal.requestId)).toEqual({ claimed: true, state: "already_settled", behavior: "allow" });
      expect(resolve(proposal.requestId)).toEqual({ claimed: true, state: "already_settled", behavior: "allow" });
      expect(commits).toHaveLength(1);
      expect(JSON.stringify([...store.threads])).not.toContain(rotated);
    });

    it("do not expire an enable card when the user only changed a secret value", () => {
      // The card shows the server's env and header names, never their values,
      // so the user's approval cannot depend on a value: rotating one in
      // settings while the card is open leaves the approved change as shown.
      const { propose, resolve, config } = harness();
      config.servers = { notes: notes(false) };
      const proposal = propose({ action: "enable", name: "notes", reason: "x" });
      config.servers = { notes: { ...notes(false), env: { NOTES_TOKEN: "rotated-by-the-user" } } };
      expect(resolve(proposal.requestId).state).toBe("applied");
      expect(config.servers.notes).toEqual({ ...notes(true), env: { NOTES_TOKEN: "rotated-by-the-user" } });
    });
  });

  it("refuses an update or a switch that would change nothing", () => {
    const { propose, config } = harness();
    config.servers = { notes: notes(true) };
    expectError(() => propose({ action: "update", name: "notes", command: "npx", env: { NOTES_TOKEN: SECRET }, reason: "x" }), /Nothing would change/);
    expectError(() => propose({ action: "enable", name: "notes", reason: "x" }), /Nothing would change: “notes” is already on/);
  });

  it("turns a server on, off, and removes it, saying what each one does", () => {
    const { propose, resolve, config, commits } = harness();
    config.servers = { notes: notes(false), docs: docs(true) };
    const enable = propose({ action: "enable", name: "notes", reason: "The user wants it on." });
    expect(enable.title).toBe("Turn on MCP server “notes”?");
    expect(enable.detail).toContain('Command: "npx"');
    expect(enable.detail).toContain("Environment names: NOTES_TOKEN");
    expect(enable.detail).toContain("Enabling runs this command on the user's computer the next time a bot's turn starts.");
    expect(resolve(enable.requestId).state).toBe("applied");
    expect(config.servers.notes).toEqual(notes(true));

    const disable = propose({ action: "disable", name: "docs", reason: "Not needed." });
    expect(disable.title).toBe("Turn off MCP server “docs”?");
    expect(disable.detail).toContain("Bots stop using it from their next turn. Nothing runs.");
    expect(resolve(disable.requestId).state).toBe("applied");
    expect(config.servers.docs).toEqual(docs(false));

    const remove = propose({ action: "remove", name: "docs", reason: "Gone." });
    expect(remove.title).toBe("Remove MCP server “docs”?");
    expect(remove.detail).toContain("Removes it from every bot.");
    expect(resolve(remove.requestId).state).toBe("applied");
    expect(config.servers).toEqual({ notes: notes(true) });
    expect(commits.map((change) => change.action)).toEqual(["enable", "disable", "remove"]);
  });

  it("expires a card whose server changed after it was prepared, terminally", () => {
    const { propose, resolve, card, config, commits } = harness();
    config.servers = { notes: notes(false) };
    const proposal = propose({ action: "enable", name: "notes", reason: "x" });
    config.servers = { notes: { ...notes(false), args: ["other"] } };
    expect(resolve(proposal.requestId)).toEqual({
      claimed: true, state: "invalid", status: 409,
      error: "This MCP server changed after this card was prepared. Ask the bot to review it and propose again.",
    });
    expect(card(proposal.requestId)).toMatchObject({ expired: true, options: [] });
    // Moving the entry back does not revive a settled card.
    config.servers = { notes: notes(false) };
    expect(resolve(proposal.requestId)).toMatchObject({ state: "invalid", error: expect.stringMatching(/expired before it was confirmed/) });
    expect(commits).toEqual([]);
  });

  it("cancels without changing anything", () => {
    const { propose, resolve, card, config, commits } = harness();
    const proposal = propose({ action: "add", name: "notes", command: "npx", env: { NOTES_TOKEN: SECRET }, reason: "x" });
    expect(resolve(proposal.requestId, "deny")).toEqual({ claimed: true, state: "denied" });
    expect(card(proposal.requestId)).toMatchObject({ answered: "deny" });
    expect(resolve(proposal.requestId, "allow")).toEqual({ claimed: true, state: "already_settled", behavior: "deny" });
    expect(config.servers).toEqual({});
    expect(commits).toEqual([]);
  });

  it("never re-applies a confirmed card, even when recording the decision failed once", () => {
    const { store, propose, resolve, card, config, commits } = harness();
    config.servers = { notes: notes(false) };
    const proposal = propose({ action: "enable", name: "notes", reason: "x" });
    store.failNextPatch = true;
    expect(resolve(proposal.requestId)).toMatchObject({ state: "applied", settlementPending: true });
    expect(commits).toHaveLength(1);
    // A later change restores the entry the card was prepared on; the card
    // still must not apply a second time.
    config.servers = { notes: notes(false) };
    expect(resolve(proposal.requestId)).toEqual({ claimed: true, state: "already_settled", behavior: "allow" });
    expect(resolve(proposal.requestId)).toEqual({ claimed: true, state: "already_settled", behavior: "allow" });
    expect(card(proposal.requestId)).toMatchObject({ answered: "allow" });
    expect(commits).toHaveLength(1);
  });

  it("pins the card to its conversation and to confirm or cancel", () => {
    const { propose, service, config } = harness();
    config.servers = { notes: notes(false) };
    const { requestId } = propose({ action: "enable", name: "notes", reason: "x" });
    expect(service.resolve({ botId: "other", threadId: THREAD, requestId, behavior: "allow" })).toMatchObject({ state: "invalid", status: 403 });
    expect(service.resolve({ botId: BOT, threadId: THREAD, requestId, behavior: "answer" })).toMatchObject({ state: "invalid", status: 400 });
    expect(service.resolve({ botId: BOT, threadId: "elsewhere", requestId, behavior: "allow" })).toEqual({ claimed: false, state: "not_found" });
  });

  it("refuses a proposer who is not an active Chief, and re-checks at confirm", () => {
    let refusal: string | null = "Only an active Chief of Staff can propose MCP server changes.";
    const { propose, resolve, card, config, service } = harness({ authorize: () => refusal });
    config.servers = { notes: notes(false) };
    expectError(() => propose({ action: "enable", name: "notes", reason: "x" }), /active Chief of Staff/, 403);
    refusal = null;
    const proposal = propose({ action: "enable", name: "notes", reason: "x" });
    service.authorize = () => "Only an active Chief of Staff can propose MCP server changes.";
    expect(resolve(proposal.requestId)).toMatchObject({ state: "invalid", status: 403 });
    expect(card(proposal.requestId)).toMatchObject({ expired: true, options: [] });
    expect(config.servers.notes).toEqual(notes(false));
  });

  it("keeps a card actionable while another settings write holds the lock", () => {
    let busy = true;
    const servers: { current: Record<string, unknown> } = { current: { notes: notes(false) } };
    const { store } = harness();
    const service = new McpServerRequestService({
      store,
      servers: () => servers.current,
      commit: (next) => {
        if (busy) throw new McpServerRequestError("MCP servers are already being updated.", 409);
        servers.current = next;
      },
    });
    const { requestId } = service.propose({ botId: BOT, threadId: THREAD, request: { action: "enable", name: "notes", reason: "x" } });
    expect(service.resolve({ botId: BOT, threadId: THREAD, requestId, behavior: "allow" }))
      .toEqual({ claimed: true, state: "invalid", status: 409, error: "MCP servers are already being updated." });
    busy = false;
    expect(service.resolve({ botId: BOT, threadId: THREAD, requestId, behavior: "allow" }).state).toBe("applied");
    expect(servers.current.notes).toEqual(notes(true));
  });

  describe("Full Access", () => {
    const fullAccess = () => harness({ autoApply: vi.fn(() => true) });

    it("applies an add, a disable, a remove, and a change to a server that is off without a card to click", () => {
      const { service, config, store } = fullAccess();
      config.servers = { docs: docs(true), old: notes(false) };
      const submit = (request: Record<string, unknown>) => service.submit({ botId: BOT, threadId: THREAD, request });
      for (const request of [
        { action: "add", name: "notes", command: "npx", env: { NOTES_TOKEN: SECRET }, reason: "x" },
        { action: "disable", name: "docs", reason: "x" },
        { action: "update", name: "old", args: ["v2"], reason: "x" },
        { action: "remove", name: "old", reason: "x" },
      ]) {
        const submitted = submit(request);
        expect(submitted.state, request.action).toBe("applied");
        const shown = store.messagesFor(THREAD).find((message) => message.card?.requestId === submitted.requestId)!.card!;
        expect(shown).toMatchObject({ options: [], dismissed: true, answered: "allow" });
      }
      expect(config.servers).toEqual({ docs: docs(false), notes: { ...notes(false), args: [] } });
    });

    it("never turns a server on, or changes one that is on, without a human click", () => {
      const { service, config, store } = fullAccess();
      config.servers = { notes: notes(false), docs: docs(true) };
      const submit = (request: Record<string, unknown>) => service.submit({ botId: BOT, threadId: THREAD, request });
      const enable = submit({ action: "enable", name: "notes", reason: "x" });
      const update = submit({ action: "update", name: "docs", url: "https://docs.example/v2/mcp", reason: "x" });
      expect(enable.state).toBe("pending");
      expect(update.state).toBe("pending");
      for (const { requestId } of [enable, update]) {
        const shown = store.messagesFor(THREAD).find((message) => message.card?.requestId === requestId)!.card!;
        expect(shown).toMatchObject({ options: ["Confirm", "Cancel"] });
        expect(shown.answered).toBeUndefined();
      }
      expect(update.detail).toContain("It stays on: bots use the changed connection the next time a bot's turn starts.");
      expect(config.servers).toEqual({ notes: notes(false), docs: docs(true) });
    });
  });

  describe("after a restart", () => {
    it("fails a card that needed held secret values closed, with a clear sentence", () => {
      const { store, options, propose, card, config } = harness();
      const proposal = propose({ action: "add", name: "notes", command: "npx", env: { NOTES_TOKEN: SECRET }, reason: "x" });
      const restarted = new McpServerRequestService(options);
      expect(restarted.resolve({ botId: BOT, threadId: THREAD, requestId: proposal.requestId, behavior: "allow" })).toEqual({
        claimed: true, state: "invalid", status: 409,
        error: "The secret values for this card were not kept after a restart. Ask the bot to propose it again.",
      });
      expect(card(proposal.requestId)).toMatchObject({ expired: true, options: [] });
      expect(config.servers).toEqual({});
      expect(JSON.stringify([...store.threads])).not.toContain(SECRET);
    });

    it("still applies a card that carries no secret values", () => {
      const { options, propose, config } = harness();
      config.servers = { notes: notes(false) };
      const enable = propose({ action: "enable", name: "notes", reason: "x" });
      const update = propose({ action: "add", name: "docs", url: "https://docs.example/mcp", reason: "x" });
      const restarted = new McpServerRequestService(options);
      for (const { requestId } of [enable, update]) {
        expect(restarted.resolve({ botId: BOT, threadId: THREAD, requestId, behavior: "allow" }).state).toBe("applied");
      }
      expect(config.servers).toEqual({ notes: notes(true), docs: { type: "http", url: "https://docs.example/mcp", headers: {}, enabled: false } });
    });
  });

  it("holds a launch spec the card had to redact, and applies the real one", () => {
    const { propose, resolve, card, config } = harness();
    const token = "--token=abcdef1234567890";
    const proposal = propose({ action: "add", name: "notes", command: "npx", args: ["notes-mcp", token], reason: "x" });
    expect(proposal.detail).not.toContain("abcdef1234567890");
    expect(card(proposal.requestId).mcpServerRequest).toMatchObject({ heldSecrets: true });
    expect(resolve(proposal.requestId).state).toBe("applied");
    expect(config.servers.notes).toEqual({ command: "npx", args: ["notes-mcp", token], env: {}, enabled: false });
  });

  it("keeps every secret value out of the whole store, the results, and the reason", () => {
    const { store, propose, resolve, config } = harness();
    config.servers = { docs: docs(false) };
    const results: unknown[] = [];
    const proposals = [
      propose({ action: "add", name: "notes", command: "npx", env: { NOTES_TOKEN: SECRET }, reason: `Use token sk-ant-${"a".repeat(24)} please.` }),
      propose({ action: "update", name: "docs", headers: { Authorization: HEADER_SECRET, "X-Extra": SECRET }, oauth: { clientId: "corp-app", clientSecret: `${CLIENT_SECRET}-2` }, reason: "x" }),
    ];
    for (const proposal of proposals) results.push(proposal, resolve(proposal.requestId));
    results.push(resolve(propose({ action: "enable", name: "notes", reason: "x" }).requestId));
    results.push(resolve(propose({ action: "remove", name: "docs", reason: "x" }).requestId));
    expect(config.servers.notes).toEqual({ ...notes(true), args: [] });
    const everything = JSON.stringify({ threads: [...store.threads], results });
    for (const secret of [SECRET, HEADER_SECRET, CLIENT_SECRET, `sk-ant-${"a".repeat(24)}`]) expect(everything).not.toContain(secret);
    expect(everything).toContain("NOTES_TOKEN");
    expect(everything).toContain("X-Extra");
  });
});
