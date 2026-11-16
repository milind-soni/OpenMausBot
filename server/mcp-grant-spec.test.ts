import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { McpServerSpec } from "./contracts.ts";
import { movedGrantKeys, moveSavedGrants, storedGrantSpec, type GrantServer } from "./mcp-grant-spec.ts";
import { providerToolAllowKey } from "./provider-tool-allow.ts";

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

describe("where a bot's moved grants are saved", () => {
  it("moves the bot's own, each thread's and the starting turn's, and leaves every other bot alone", () => {
    const saved = earlierKey("claude", "notes", "list_notes", started(4));
    const bots = new Map([
      ["iris", { alwaysAllow: [saved, "Bash:ls"], tasks: [{ threadId: "a", alwaysAllow: [saved] }, { threadId: "b", alwaysAllow: [] as string[] }, { threadId: "c" }] }],
      ["paul", { alwaysAllow: [saved], tasks: [{ threadId: "p", alwaysAllow: [saved] }] }],
    ]);
    const writes: string[] = [];
    const store = {
      bot: (id: string) => bots.get(id),
      tasks: (id: string) => bots.get(id)?.tasks ?? [],
      patchBot: (id: string, patch: { alwaysAllow: string[] }) => { writes.push(`bot:${id}`); bots.get(id)!.alwaysAllow = patch.alwaysAllow; },
      patchTask: (id: string, threadId: string, patch: { alwaysAllow: string[] }) => { writes.push(`task:${id}:${threadId}`); bots.get(id)!.tasks.find((task) => task.threadId === threadId)!.alwaysAllow = patch.alwaysAllow; },
    };
    const live = { id: "iris", alwaysAllow: [saved] };
    const move = (keys: readonly string[]) => movedGrantKeys(keys, servers());
    moveSavedGrants(store, live, move);
    const key = now("claude", "list_notes");
    expect(bots.get("iris")).toEqual({ alwaysAllow: [key, "Bash:ls"], tasks: [{ threadId: "a", alwaysAllow: [key] }, { threadId: "b", alwaysAllow: [] }, { threadId: "c" }] });
    expect(live.alwaysAllow).toEqual([key]);
    expect(bots.get("paul"), "another bot's grant is its own to move, in its own turn").toEqual({ alwaysAllow: [saved], tasks: [{ threadId: "p", alwaysAllow: [saved] }] });
    expect(writes).toEqual(["bot:iris", "task:iris:a"]);
    moveSavedGrants(store, live, move);
    expect(writes, "nothing is written when nothing moves").toHaveLength(2);
    moveSavedGrants(store, { id: "gone" }, move);
  });
});
