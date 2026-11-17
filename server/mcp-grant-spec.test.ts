import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { McpServerSpec } from "./contracts.ts";
import { rewriteGrantLists, type GrantRewrite } from "./always-allow.ts";
import { grantMover, grantServersMark, movedGrantKeys, moveSavedGrants, storedGrantSpec, type GrantServer } from "./mcp-grant-spec.ts";
import { providerToolAllowKey } from "./provider-tool-allow.ts";

vi.mock("./provider-tool-allow.ts", async (original) => {
  const real = await original<typeof import("./provider-tool-allow.ts")>();
  return { ...real, providerToolAllowKey: vi.fn(real.providerToolAllowKey) };
});

const SECRET = "sk_fake-value-in-the-vault";
const POINTER = "vault:11111111-1111-4111-8111-111111111111";
const stored = { command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_KEY: POINTER, REGION: "eu" }, enabled: true };
const names = storedGrantSpec("notes", stored)!;
/** The server as a turn starts it: its Vault key read, and its restart count when it has one. */
const started = (restarts = 0, secret = SECRET): McpServerSpec =>
  ({ command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_KEY: secret, REGION: "eu", ...(restarts ? { OMB_MCP_RESTART: String(restarts) } : {}) } });
/** The key earlier versions saved: the fingerprint of the whole started server. */
const earlierKey = (instance: string, server: string, tool: string, spec: unknown): string =>
  `provider-tool:${instance}:${server}:${tool}:${createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16)}`;
const servers = (restarts = 0): Record<string, GrantServer> => ({ notes: { names, started: started(restarts) } });
const now = (instance: string, tool: string, spec: McpServerSpec = names) => providerToolAllowKey(instance, `mcp__notes__${tool}`, spec)!;

describe("the server a saved grant names", () => {
  it("is the config.json entry: a Vault key by its reference, and nothing a restart adds", () => {
    expect(names).toEqual({ command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_KEY: POINTER, REGION: "eu" } });
    expect(storedGrantSpec("linear", { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: POINTER }, enabled: true }))
      .toEqual({ type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: POINTER } });
    expect(storedGrantSpec("broken", { args: [] })).toBeNull();
  });

  it("is, for a server with no Vault key and no restart, to the letter what earlier versions fingerprinted, so its saved grants need no move", () => {
    const plain = { command: "npx", args: ["plain-mcp"], env: { TOKEN: "plain-value" } };
    expect(JSON.stringify(storedGrantSpec("notes", { ...plain, enabled: true }))).toBe(JSON.stringify(plain));
    const remote = { type: "http" as const, url: "https://mcp.linear.app/mcp", headers: {} };
    expect(JSON.stringify(storedGrantSpec("linear", { ...remote, enabled: true }))).toBe(JSON.stringify(remote));
  });
});

describe("moving grants an earlier version saved", () => {
  it("moves a grant saved under the key's value, or under a restart count, to the same tool on the same server", () => {
    for (const restarts of [0, 1, 7, 20]) {
      const saved = earlierKey("claude", "notes", "list_notes", started(restarts));
      expect(saved).not.toBe(now("claude", "list_notes"));
      expect(movedGrantKeys(["Bash:git status", saved], servers()), `restart count ${restarts}`).toEqual(["Bash:git status", now("claude", "list_notes")]);
    }
    // The count the server has today is not what the saved grant has to match.
    expect(movedGrantKeys([earlierKey("claude", "notes", "list_notes", started(2))], servers(5))).toEqual([now("claude", "list_notes")]);
  });

  it("changes nothing once moved, and folds a moved grant into the one already saved", () => {
    const saved = earlierKey("claude", "notes", "list_notes", started());
    const moved = movedGrantKeys([saved], servers())!;
    expect(movedGrantKeys(moved, servers())).toBeNull();
    expect(movedGrantKeys([now("claude", "list_notes"), saved], servers())).toEqual([now("claude", "list_notes")]);
    expect(movedGrantKeys([], servers())).toBeNull();
  });

  it("keeps the AI, the server and the tool of every grant it moves", () => {
    const saved = [
      earlierKey("claude", "notes", "list_notes", started()),
      earlierKey("codex", "notes", "list_notes", started(3)),
      earlierKey("openaiCompat:local", "notes", "get_note", started()),
    ];
    const moved = movedGrantKeys(saved, servers())!;
    expect(moved).toEqual([now("claude", "list_notes"), now("codex", "list_notes"), now("openaiCompat:local", "get_note")]);
    moved.forEach((key, index) => expect(key.slice(0, -16)).toBe(saved[index]!.slice(0, -16)));
    expect(new Set(moved.map((key) => key.slice(-16))).size, "one server, one fingerprint").toBe(1);
  });

  it("never moves a grant to a server set up differently, another server, another tool or a tool that sends", () => {
    const other = (spec: Partial<{ command: string; args: string[]; env: Record<string, string> }>) => ({ ...started(), ...spec });
    const kept = [
      earlierKey("claude", "notes", "list_notes", other({ command: "node" })),
      earlierKey("claude", "notes", "list_notes", other({ args: ["-y", "notes-mcp", "--all-accounts"] })),
      earlierKey("claude", "notes", "list_notes", other({ env: { NOTES_KEY: SECRET, REGION: "us" } })),
      // Saved under a key value the Vault no longer holds: it stopped matching before, and is not revived.
      earlierKey("claude", "notes", "list_notes", started(0, "sk_fake-older-value")),
      earlierKey("claude", "notes", "list_notes", started(21)),
      // Another server that happened to be started the same way keeps its own key.
      earlierKey("claude", "journal", "list_notes", started()),
      earlierKey("claude", "notes", "send_email", started()),
      "provider-tool:claude:notes:list_notes:not-a-fingerprint",
      "provider-tool:notes",
      "peer:teammate",
      "Bash:git status",
    ];
    expect(movedGrantKeys(kept, servers())).toBeNull();
    // A server of that name on this bot that is set up differently today takes none of the old grants either.
    const changed: Record<string, GrantServer> = { notes: { names: { ...names, args: ["other-mcp"] }, started: { ...started(), args: ["other-mcp"] } } };
    expect(movedGrantKeys([earlierKey("claude", "notes", "list_notes", started())], changed)).toBeNull();
    expect(movedGrantKeys([earlierKey("claude", "notes", "list_notes", started())], {})).toBeNull();
  });

  it("moves a grant for a server reached by URL whose header is a Vault key", () => {
    const remote = { type: "http" as const, url: "https://notes.example/mcp", headers: { Authorization: `Bearer ${POINTER}` } };
    const startedRemote = { ...remote, headers: { Authorization: `Bearer ${SECRET}` } };
    const saved = earlierKey("claude", "notes", "list_notes", startedRemote);
    expect(movedGrantKeys([saved], { notes: { names: remote, started: startedRemote } })).toEqual([now("claude", "list_notes", remote)]);
    expect(movedGrantKeys([earlierKey("claude", "notes", "list_notes", { ...startedRemote, url: "https://elsewhere.example/mcp" })], { notes: { names: remote, started: startedRemote } })).toBeNull();
  });

  it("puts no key value in a fingerprint or a saved grant", () => {
    const moved = movedGrantKeys([earlierKey("claude", "notes", "list_notes", started())], servers())!;
    expect(JSON.stringify(names)).not.toContain(SECRET);
    expect(moved.join()).not.toContain(SECRET);
    expect(moved[0]).toMatch(/^provider-tool:claude:notes:list_notes:[a-f0-9]{16}$/);
    // The same reference with another value behind it is the same grant: the value is not in the fingerprint.
    expect(movedGrantKeys(moved, { notes: { names, started: started(0, "sk_fake-rotated") } })).toBeNull();
    expect(now("claude", "list_notes")).toBe(moved[0]);
  });
});

/** The names of every object in order, as one earlier version wrote a server before fingerprinting it. */
const inOrder = (value: unknown): unknown => Array.isArray(value) ? value.map(inOrder)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, inOrder(item)])) : value;

describe("grants saved by the version that wrote a server's names in order", () => {
  it("move too, under a Vault key's value or a restart count, and under no other server", () => {
    for (const restarts of [0, 3, 20]) {
      const saved = earlierKey("claude", "notes", "list_notes", inOrder(started(restarts)));
      expect(saved).not.toBe(earlierKey("claude", "notes", "list_notes", started(restarts)));
      expect(movedGrantKeys([saved], servers()), `restart count ${restarts}`).toEqual([now("claude", "list_notes")]);
    }
    expect(movedGrantKeys([earlierKey("claude", "notes", "list_notes", inOrder({ ...started(), args: ["other-mcp"] }))], servers())).toBeNull();
    expect(movedGrantKeys([earlierKey("claude", "notes", "list_notes", inOrder(started(21)))], servers())).toBeNull();
    const remote = { type: "http" as const, url: "https://notes.example/mcp", headers: { Authorization: `Bearer ${POINTER}` } };
    const startedRemote = { ...remote, headers: { Authorization: `Bearer ${SECRET}` } };
    expect(movedGrantKeys([earlierKey("claude", "notes", "list_notes", inOrder(startedRemote))], { notes: { names: remote, started: startedRemote } })).toEqual([now("claude", "list_notes", remote)]);
  });
});

describe("what moving a bot's grants costs", () => {
  const keyFor = vi.mocked(providerToolAllowKey);
  const tenServers = (): Record<string, GrantServer> => Object.fromEntries(Array.from({ length: 10 }, (_, i) => {
    const spec = { command: "npx", args: [`server-${i}`], env: { KEY: POINTER } };
    return [`server${i}`, { names: spec, started: { ...spec, env: { KEY: SECRET } } }];
  }));
  const savedKeys = (all: Record<string, GrantServer>) => Array.from({ length: 150 }, (_, i) => earlierKey("claude", `server${i % 10}`, `list_${i}`, all[`server${i % 10}`]!.started));

  it("works each distinct key out once however many threads hold it, and saves the bot and all its threads in one write", () => {
    const all = tenServers();
    const keys = savedKeys(all);
    const bot = { id: "iris", alwaysAllow: [...keys], tasks: Array.from({ length: 200 }, () => ({ alwaysAllow: [...keys, "Bash:ls"] })) };
    const save = vi.fn();
    const store = { rewriteGrants: (_botId: string, rewrite: GrantRewrite) => rewriteGrantLists(bot, rewrite, save) };
    keyFor.mockClear();
    moveSavedGrants(store, { id: "iris", alwaysAllow: [...keys] }, grantMover(all));
    expect(save, "one write for the bot and its 200 threads").toHaveBeenCalledOnce();
    expect(keyFor.mock.calls.length, "150 distinct keys, 30,000 held").toBe(150);
    const moved = bot.alwaysAllow;
    expect(moved).toEqual(keys.map((_key, i) => providerToolAllowKey("claude", `mcp__server${i % 10}__list_${i}`, all[`server${i % 10}`]!.names)));
    expect(bot.tasks.every((task) => JSON.stringify(task.alwaysAllow) === JSON.stringify([...moved, "Bash:ls"]))).toBe(true);

    // Gone over again by a new mover (a later start): keys already moved are told apart without a write.
    keyFor.mockClear();
    moveSavedGrants(store, { id: "iris", alwaysAllow: [...moved] }, grantMover(all));
    expect(save).toHaveBeenCalledOnce();
    expect(keyFor.mock.calls.length, "no key is worked out again").toBe(0);
  });

  it("puts every list back when the one save fails, so a grant is never half moved", () => {
    const all = tenServers();
    const keys = savedKeys(all);
    const bot = { id: "iris", alwaysAllow: [...keys], tasks: [{ alwaysAllow: [...keys] }, {}] };
    const store = { rewriteGrants: (_botId: string, rewrite: GrantRewrite) => rewriteGrantLists(bot, rewrite, () => { throw new Error("fixture disk full"); }) };
    const live = { id: "iris", alwaysAllow: [...keys] };
    expect(() => moveSavedGrants(store, live, grantMover(all))).toThrow("fixture disk full");
    expect(bot).toEqual({ id: "iris", alwaysAllow: keys, tasks: [{ alwaysAllow: keys }, {}] });
    expect(live.alwaysAllow).toEqual(keys);
  });

  it("tells one set of servers from another without keeping a key value", () => {
    const all = tenServers();
    expect(grantServersMark(all)).toBe(grantServersMark(tenServers()));
    expect(grantServersMark(all)).toMatch(/^[a-f0-9]{64}$/);
    expect(grantServersMark({ ...all, server0: { ...all.server0!, started: { ...all.server0!.started, env: { KEY: "sk_fake-rotated" } } as McpServerSpec } })).not.toBe(grantServersMark(all));
  });
});

describe("where a bot's moved grants are saved", () => {
  it("moves the bot's own, each thread's and the starting turn's, and leaves every other bot alone", () => {
    const saved = earlierKey("claude", "notes", "list_notes", started(4));
    const bots = new Map([
      ["iris", { id: "iris", alwaysAllow: [saved, "Bash:ls"], tasks: [{ threadId: "a", alwaysAllow: [saved] }, { threadId: "b", alwaysAllow: [] as string[] }, { threadId: "c" }] }],
      ["paul", { id: "paul", alwaysAllow: [saved], tasks: [{ threadId: "p", alwaysAllow: [saved] }] }],
    ]);
    const writes: string[] = [];
    const store = { rewriteGrants: (botId: string, rewrite: GrantRewrite) => Boolean(bots.get(botId) && rewriteGrantLists(bots.get(botId)!, rewrite, () => writes.push(botId))) };
    const live = { id: "iris", alwaysAllow: [saved] };
    const move = grantMover(servers());
    moveSavedGrants(store, live, move);
    const key = now("claude", "list_notes");
    expect(bots.get("iris")).toEqual({ id: "iris", alwaysAllow: [key, "Bash:ls"], tasks: [{ threadId: "a", alwaysAllow: [key] }, { threadId: "b", alwaysAllow: [] }, { threadId: "c" }] });
    expect(live.alwaysAllow).toEqual([key]);
    expect(bots.get("paul"), "another bot's grant is its own to move, in its own turn").toEqual({ id: "paul", alwaysAllow: [saved], tasks: [{ threadId: "p", alwaysAllow: [saved] }] });
    expect(writes).toEqual(["iris"]);
    moveSavedGrants(store, live, move);
    expect(writes, "nothing is written when nothing moves").toHaveLength(1);
    moveSavedGrants(store, { id: "gone" }, move);
  });
});
