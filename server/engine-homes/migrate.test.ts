import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Audience } from "../audience.ts";
import { HELD_DAYS, audienceHome } from "./layout.ts";
import { claudeProjectSlug, migrateEngineHomes, storeThreads, sweepHeld } from "./migrate.ts";

const OWNER_SESSION = "0a1b2c3d-1111-4222-8333-444455556666";
const BOB_SESSION = "0a1b2c3d-2222-4222-8333-444455556666";
const LOST_SESSION = "0a1b2c3d-3333-4222-8333-444455556666";
const CODEX_THREAD = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
const LOST_CODEX = "019a2b3c-4d5e-7f60-8a9b-ffffffffffff";

let root = "", home = "", dataDir = "";
const put = (path: string, text = "x") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const audiences: Record<string, Audience> = { "t-owner": "member:p_olive", "t-bob": "member:p_bob", "t-main": "team", "t-pinned": "room:r1" };
const input = (now = 1_000_000) => ({
  dataDir, serverHome: home, env: { HOME: home }, now,
  threads: () => storeThreads([
    { threadId: "t-main", resumeCursors: {}, tasks: [
      { threadId: "t-owner", resumeCursors: { claude: OWNER_SESSION, codex: CODEX_THREAD }, cwd: join(dataDir, "task-workspaces", "b1", "t-owner") },
      { threadId: "t-bob", resumeCursors: { claude: BOB_SESSION }, cwd: join(dataDir, "task-workspaces", "b1", "t-bob") },
      { threadId: "t-pinned", resumeCursors: {}, cwd: "/srv/site" },
    ] },
  ]),
  audienceOf: (threadId: string) => audiences[threadId] ?? "team",
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-migrate-"));
  home = join(root, "home");
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the first start with engine homes", () => {
  it("moves each transcript to its conversation's audience home and holds what matches no conversation", () => {
    const ownerSlug = claudeProjectSlug(join(dataDir, "task-workspaces", "b1", "t-owner"));
    const botSlug = claudeProjectSlug(join(dataDir, "workspaces", "b1"));
    put(join(home, ".claude", "projects", ownerSlug, `${OWNER_SESSION}.jsonl`), "owner says hi");
    put(join(home, ".claude", "projects", ownerSlug, OWNER_SESSION, "subagents", "a.jsonl"), "owner subagent");
    put(join(home, ".claude", "projects", botSlug, `${BOB_SESSION}.jsonl`), "bob's secret is sardine");
    put(join(home, ".claude", "projects", botSlug, `${LOST_SESSION}.jsonl`), "nobody's");
    put(join(home, ".claude", "projects", claudeProjectSlug("/srv/site"), "older-session.jsonl"), "the pinned folder's");
    put(join(home, ".claude", "history.jsonl"), "every prompt");
    put(join(home, ".claude", "file-history", BOB_SESSION, "v1"), "bob's file");
    put(join(home, ".claude", ".credentials.json"), "{}");
    put(join(home, ".codex", "sessions", "2026", "10", "20", `rollout-2026-10-20T10-00-00-${CODEX_THREAD}.jsonl`), "owner's codex");
    put(join(home, ".codex", "sessions", "2026", "10", "21", `rollout-2026-10-21T10-00-00-${LOST_CODEX}.jsonl`), "lost codex");
    put(join(home, ".codex", "auth.json"), "{}");

    const result = migrateEngineHomes(input());
    expect(result).toMatchObject({ ran: true, moved: 6, held: 3 });
    const owner = audienceHome(dataDir, "member:p_olive"), bob = audienceHome(dataDir, "member:p_bob");
    expect(readFileSync(join(owner, ".claude", "projects", ownerSlug, `${OWNER_SESSION}.jsonl`), "utf8")).toBe("owner says hi");
    expect(readFileSync(join(owner, ".claude", "projects", ownerSlug, OWNER_SESSION, "subagents", "a.jsonl"), "utf8")).toBe("owner subagent");
    expect(readFileSync(join(bob, ".claude", "projects", botSlug, `${BOB_SESSION}.jsonl`), "utf8")).toContain("sardine");
    expect(readFileSync(join(bob, ".claude", "file-history", BOB_SESSION, "v1"), "utf8")).toBe("bob's file");
    expect(readFileSync(join(owner, ".codex", "sessions", "2026", "10", "20", `rollout-2026-10-20T10-00-00-${CODEX_THREAD}.jsonl`), "utf8")).toBe("owner's codex");
    // A folder only one conversation runs in names that conversation, whatever the session.
    expect(existsSync(join(audienceHome(dataDir, "room:r1"), ".claude", "projects", claudeProjectSlug("/srv/site"), "older-session.jsonl"))).toBe(true);
    const held = join(dataDir, "engine-homes", ".held", "1000000");
    expect(readFileSync(join(held, ".claude", "projects", botSlug, `${LOST_SESSION}.jsonl`), "utf8")).toBe("nobody's");
    expect(readFileSync(join(held, ".claude", "history.jsonl"), "utf8")).toBe("every prompt");
    expect(existsSync(join(held, ".codex", "sessions", "2026", "10", "21", `rollout-2026-10-21T10-00-00-${LOST_CODEX}.jsonl`))).toBe(true);
    // Nothing of any conversation stays in the server's HOME; its sign-ins do.
    expect(readdirSync(join(home, ".claude", "projects"))).toEqual([]);
    expect(existsSync(join(home, ".claude", "history.jsonl"))).toBe(false);
    expect(existsSync(join(home, ".claude", ".credentials.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "auth.json"))).toBe(true);
    // Bob's transcript is nowhere in the Owner's home.
    expect(JSON.stringify(readdirSync(owner, { recursive: true }))).not.toContain(BOB_SESSION);
  });

  it("runs once: a later start moves nothing, and an engine's later files stay where they are", () => {
    expect(migrateEngineHomes(input())).toMatchObject({ ran: true, moved: 0, held: 0 });
    put(join(home, ".claude", "projects", "x", `${LOST_SESSION}.jsonl`));
    expect(migrateEngineHomes(input())).toMatchObject({ ran: false, moved: 0 });
    expect(existsSync(join(home, ".claude", "projects", "x", `${LOST_SESSION}.jsonl`))).toBe(true);
  });

  it("a session file already in its home is held, never written over", () => {
    const slug = claudeProjectSlug(join(dataDir, "task-workspaces", "b1", "t-bob"));
    const bob = audienceHome(dataDir, "member:p_bob");
    put(join(bob, ".claude", "projects", slug, `${BOB_SESSION}.jsonl`), "newer");
    put(join(home, ".claude", "projects", slug, `${BOB_SESSION}.jsonl`), "older");
    expect(migrateEngineHomes(input())).toMatchObject({ moved: 0, held: 1 });
    expect(readFileSync(join(bob, ".claude", "projects", slug, `${BOB_SESSION}.jsonl`), "utf8")).toBe("newer");
  });

  it("deletes held folders after their grace period", () => {
    const day = 86_400_000, now = 100 * day;
    put(join(dataDir, "engine-homes", ".held", String(now - (HELD_DAYS + 1) * day), "old"));
    put(join(dataDir, "engine-homes", ".held", String(now - day), "recent"));
    expect(sweepHeld(dataDir, now)).toBe(1);
    expect(readdirSync(join(dataDir, "engine-homes", ".held"))).toEqual([String(now - day)]);
  });
});
