import { describe, expect, it } from "vitest";
import { createAboutMe } from "../about-me.ts";
import { botMemoryUpdate } from "../memory-forget.ts";
import { isForgotten } from "../profile-learned.ts";
import { MEMORY_MAX_LINES, readMemoryFile, readMemoryTopic, writeMemoryFile, writeMemoryTopic } from "../workspace.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";

function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    botId: "bot-voice",
    threadId: "thread-voice",
    depth: 0,
    externalRuntime: false,
    sharedComputers: false,
    client: {
      api: async () => ({}),
      apiResponse: async () => ({ ok: true, status: 200, body: {} }),
    },
    ...overrides,
  };
}

describe("send_voice_note", () => {
  it("refuses a missing or blank note with the shape a retry needs", async () => {
    for (const args of [{}, { text: "   " }]) {
      const result = await callTool("send_voice_note", args, context());
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toContain("send_voice_note needs text");
    }
    expect(await callTool("send_voice_note", { text: "" }, context())).toEqual({ text: "send_voice_note was not run: text must not be empty. Fix these and call it again.", isError: true });
  });

  it("refuses a note over 1000 characters and reports the length", async () => {
    const result = await callTool("send_voice_note", { text: "a".repeat(1001) }, context());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("1000 characters");
    expect(result.text).toContain("1001");
  });

  it("posts the trimmed verbatim note to the harness route", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("send_voice_note", { text: "  Ship it.  " }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Voice note recorded");
    expect(calls).toEqual([
      { path: "/api/internal/voice-note", body: { fromBotId: "bot-voice", fromThreadId: "thread-voice", text: "Ship it." } },
    ]);
  });

  it("surfaces missing voice setup as a tool error, never a thrown turn", async () => {
    const result = await callTool("send_voice_note", { text: "Hello" }, context({
      client: {
        api: async () => { throw new Error("Pick a voice in the agent profile."); },
        apiResponse: async () => ({ ok: false, status: 409, body: { error: "Pick a voice in the agent profile." } }),
      },
    }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Pick a voice in the agent profile.");
  });
});

describe("create_bot", () => {
  it("passes a working folder through to the internal create route", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("create_bot", { name: "Scout", role: "Ops", instructions: "Work.", cwd: "  /tmp/ops  " }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { id: "b1", name: "Scout", section: "Work" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      { path: "/api/internal/create-bot", body: { fromBotId: "bot-voice", fromThreadId: "thread-voice", name: "Scout", role: "Ops", instructions: "Work.", cwd: "/tmp/ops" } },
    ]);
  });
});

describe("add_mcp_server", () => {
  it("posts the arguments and tells the model the server was saved off", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const result = await callTool("add_mcp_server", {
      name: "notes",
      command: "npx",
      args: ["-y", "notes-mcp"],
      env: { NOTES_TOKEN: "super-secret" },
    }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { name: "notes", enabled: false, transport: "command", target: "npx", envKeys: ["NOTES_TOKEN"], headerKeys: [] };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Saved MCP server “notes” (command npx) switched off.");
    expect(result.text).toContain("MCP server settings");
    expect(result.text).toContain("runs that command on their computer");
    expect(result.text).toContain("NOTES_TOKEN");
    expect(result.text).not.toContain("super-secret");
    expect(calls).toEqual([{
      path: "/api/internal/mcp-servers",
      body: { name: "notes", command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "super-secret" } },
    }]);
  });

  it("returns the route's error sentence without echoing a secret", async () => {
    const result = await callTool("add_mcp_server", {
      name: "docs",
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer hidden" },
      enabled: true,
    }, context({
      client: {
        api: async () => { throw new Error("A bot cannot change the on/off switch. The server is saved off, and only the user can turn it on in MCP server settings."); },
        apiResponse: async () => ({ ok: false, status: 400, body: {} }),
      },
    }));
    expect(result).toEqual({
      text: "A bot cannot change the on/off switch. The server is saved off, and only the user can turn it on in MCP server settings.",
      isError: true,
    });
    expect(result.text).not.toContain("hidden");
  });
});

describe("propose_profile", () => {
  it("rejects a non-boolean toggle without proposing the valid half", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const ctx = context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    });
    const result = await callTool("propose_profile", { description: "Calmer replies.", notifications: "on" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("propose_profile notifications and speakReplies must be true or false.");
    expect(calls).toEqual([]);
  });

  it("passes boolean toggles through with the other fields", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("propose_profile", { description: "Calmer replies.", notifications: false, speakReplies: true, reason: "Use calmer replies." }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return {};
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/internal/profile-requests",
        body: {
          fromBotId: "bot-voice",
          fromThreadId: "thread-voice",
          changes: { description: "Calmer replies.", notifications: false, speakReplies: true },
          reason: "Use calmer replies.",
        },
      },
    ]);
  });
});

describe("memory_update", () => {
  // The harness route, in process: the real write behind the tool, and an About me held in memory.
  const profile = { aboutMe: "" };
  const aboutMe = createAboutMe({ read: () => profile.aboutMe, write: (text) => { profile.aboutMe = text; }, changed: () => undefined, today: () => "2026-10-27" });
  const harness = (botId: string): ToolCallContext["client"] => ({
    api: async () => ({}),
    apiResponse: async (_path, init) => {
      const body = JSON.parse(String(init?.body));
      const result = botMemoryUpdate(botId, body, { source: 'chat "Turn"', aboutMe });
      return { ok: result.ok, status: result.ok ? 200 : "code" in result && result.code === "conflict" ? 409 : 400, body: result };
    },
  });

  it("saves every note in a turn on a full file, saying what moved to the archive, and never closes the tool", async () => {
    const bot = "bot-memory-full";
    writeMemoryFile(bot, Array.from({ length: MEMORY_MAX_LINES }, (_, i) => `- 2026-09-01 · old ${i}\n`).join(""));
    const ctx = context({ botId: bot, client: harness(bot) });
    for (let i = 0; i < 4; i += 1) {
      const stale = await callTool("memory_update", { action: "remove", old_text: "no such passage" }, ctx);
      expect(stale).toMatchObject({ isError: true });
    }
    for (let i = 0; i < 10; i += 1) {
      const result = await callTool("memory_update", { action: "append", text: `note ${i}` }, ctx);
      expect(result.isError, result.text).toBeFalsy();
      expect(result.text).toMatch(new RegExp(`^Memory updated\\. Entry: - \\d{4}-\\d{2}-\\d{2} · from chat "Turn" · note ${i}\\n`));
      expect(result.text).toMatch(new RegExp(`\\nTo stay within what loads each session, moved 1 older entry to your archive \\(session_search finds them\\):\\n- 2026-09-01 · old ${i}$`));
    }
    const text = readMemoryFile(bot).text;
    for (let i = 0; i < 10; i += 1) expect(text).toContain(` · note ${i}\n`);
    expect(readMemoryTopic(bot, "archive.md")).toContain("- 2026-09-01 · old 9 · moved");
  });

  it("names only the first few entries a write moved, each by its first line, and counts the rest", async () => {
    const bot = "bot-memory-grown";
    // a file grown far past the budget by hand: one write moves hundreds
    const grown = Array.from({ length: 600 }, (_, i) => `- 2026-09-01 · old ${i}`);
    grown[0] = "- 2026-08-01 · Deploy command:\n  ```sh\n  railway up\n  ```";
    writeMemoryFile(bot, `${grown.join("\n")}\n`);
    const result = await callTool("memory_update", { action: "append", text: "one more" }, context({ botId: bot, client: harness(bot) }));
    expect(result.isError).toBeFalsy();
    expect(result.text.split("\nTo stay")[1]).toBe(
      " within what loads each session, moved 401 older entries to your archive (session_search finds them):\n" +
      "- 2026-08-01 · Deploy command:\n- 2026-09-01 · old 1\n- 2026-09-01 · old 2\n- 2026-09-01 · old 3\n- 2026-09-01 · old 4\n…and 396 more",
    );
    expect(readMemoryTopic(bot, "archive.md")).toContain("- 2026-08-01 · Deploy command: · moved");
  });

  it("tells the bot plainly when hand-written lines fill what loads", async () => {
    const bot = "bot-memory-hand";
    writeMemoryFile(bot, Array.from({ length: MEMORY_MAX_LINES }, (_, i) => `- note ${i}\n`).join(""));
    const result = await callTool("memory_update", { action: "append", text: "kept anyway" }, context({ botId: bot, client: harness(bot) }));
    expect(result.isError).toBeFalsy();
    expect(result.text).toMatch(/^Memory updated\. Entry: - \d{4}-\d{2}-\d{2} · from chat "Turn" · kept anyway\nSaved, but the lines that never move out of MEMORY\.md \(hand-written ones, health and safety facts\) fill what loads each session, so the newest entries do not load\. Tell the person their saved notes are full, and that they can remove ones they no longer need under What it remembers in your panel\.$/);
    expect(readMemoryFile(bot).text).toContain(" · kept anyway\n");
  });

  it("saves a preference once in the About me every bot reads, says not to pass it on, and only for work a person began", async () => {
    const bot = "bot-memory-prefer";
    profile.aboutMe = "I live in Pune.";
    let allowed = true;
    const client: ToolCallContext["client"] = {
      api: async () => ({}),
      apiResponse: async (_path, init) => {
        const body = JSON.parse(String(init?.body));
        const prefer = allowed ? { person: "Ada", save: (text: string) => aboutMe.learn({ botId: bot, botName: "Scout" }, [text]) } : null;
        const result = botMemoryUpdate(bot, body, { source: 'chat "Turn"', aboutMe, prefer });
        return { ok: result.ok, status: result.ok ? 200 : 400, body: result };
      },
    };
    const ctx = context({ botId: bot, client });
    const saved = await callTool("memory_update", { action: "prefer", text: "Reminders  go to the task app" }, ctx);
    expect(saved).toEqual({ text: "Saved in Ada's About me, which every bot reads in their work. Don't pass it on to other bots or save it in your own notes too." });
    expect(profile.aboutMe).toBe("I live in Pune.\n- 2026-10-27 · learned by Scout · Reminders go to the task app");
    expect(readMemoryFile(bot).text, "nothing went into the bot's own notes").not.toContain("task app");
    expect((await callTool("memory_update", { action: "prefer", text: "Reminders go to the task app" }, ctx)).text)
      .toBe("Already in Ada's About me, or they removed it before: nothing to save or pass on.");
    expect(await callTool("memory_update", { action: "prefer" }, ctx)).toMatchObject({ isError: true });
    expect(await callTool("memory_update", { action: "prefer", text: "x".repeat(301) }, ctx)).toMatchObject({ isError: true, text: expect.stringContaining("at most 300 characters") });
    allowed = false;
    expect(await callTool("memory_update", { action: "prefer", text: "Replies in German" }, ctx))
      .toMatchObject({ isError: true, text: "Only work one person began with their own words can save their preference: ask them to say it in their own chat with you." });
    expect(profile.aboutMe).not.toContain("German");
  });

  it("forgets a fact everywhere it was kept, says so without naming a file, and keeps it from being learned again", async () => {
    const bot = "bot-memory-forget";
    const ctx = context({ botId: bot, client: harness(bot) });
    expect((await callTool("memory_update", { action: "append", text: "The person prefers short answers" }, ctx)).isError).toBeFalsy();
    await callTool("memory_update", { action: "append", text: "The person is in India (IST)" }, ctx);
    writeMemoryTopic(bot, "work.md", "---\ntitle: work\naliases: [job, short answers]\n---\n- 2026-10-27 · from chat \"Remember: short answers\" (noticed) · The person wants short answers at work\n- 2026-10-27 · The person works on OpenMausBot\n");
    profile.aboutMe = "I live in Pune.\n- 2026-10-27 · learned by Scout · The person prefers short answers";

    const forgot = await callTool("memory_update", { action: "forget", old_text: "short answers" }, ctx);
    expect(forgot.isError).toBeFalsy();
    expect(forgot.text).toBe('Forgotten everywhere it was saved, About me included, which all their bots read: "The person prefers short answers", "The person wants short answers at work". Confirm to the person in one plain line what you forgot.');
    expect(forgot.text).not.toMatch(/MEMORY\.md|memory\/|\.md\b/);
    expect(readMemoryFile(bot).text).not.toContain("short answers");
    expect(readMemoryFile(bot).text).toContain("The person is in India (IST)");
    const work = readMemoryTopic(bot, "work.md")!;
    expect(work).toContain("aliases: [job, short answers]");
    expect(work).not.toContain("wants short answers");
    expect(work).toContain("The person works on OpenMausBot");
    expect(profile.aboutMe).toBe("I live in Pune.");
    expect(isForgotten("The person likes short answers")).toBe(true);

    expect((await callTool("memory_update", { action: "forget", old_text: "short answers" }, ctx)).text).toMatch(/^Nothing saved mentions "short answers": not in your notes, not in About me\./);
    expect(await callTool("memory_update", { action: "forget", old_text: "ab" }, ctx)).toMatchObject({ isError: true });
    expect(await callTool("memory_update", { action: "forget" }, ctx)).toMatchObject({ isError: true });

    await callTool("memory_update", { action: "append", text: "The person prefers short answers again" }, ctx);
    expect(isForgotten("The person likes short answers")).toBe(false);
  });

  it("removes a whole dated entry when only its fact is named, never leaving a note with a date and no text", async () => {
    const bot = "bot-memory-remove";
    writeMemoryFile(bot, '- 2026-10-27 · from chat "Remember" (noticed) · The person prefers short answers\n- Keep this unique fact.\n');
    expect((await callTool("memory_update", { action: "remove", old_text: "The person prefers short answers" }, context({ botId: bot, client: harness(bot) }))).isError).toBeFalsy();
    expect(readMemoryFile(bot).text).toBe("- Keep this unique fact.\n");
  });
});

describe("propose_team_memory", () => {
  it.each(["person", "place", "decision", "term"])("sends the %s proposal with exact identity and never claims immediate publication", async (kind) => {
    const calls: Array<{ path: string; body: any }> = [];
    const result = await callTool("propose_team_memory", { kind, name: "  Fixture name  ", detail: "  Unreviewed detail  ", aliases: ["Alias"] }, context({
      client: {
        api: async (path, init) => {
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return { status: "proposed", requestId: "proposal-fixture", summary: "Needs admin review" };
        },
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).not.toBe(true);
    expect(result.text).toMatch(/confirm|wait/i);
    expect(result.text).not.toContain("Remembered for the team");
    expect(calls).toEqual([{ path: "/api/internal/team-memory", body: {
      fromBotId: "bot-voice", fromThreadId: "thread-voice", kind, name: "Fixture name", detail: "Unreviewed detail", aliases: ["Alias"],
    } }]);
  });

  it("reports a fact that applied on its own as applied, with no card to wait for", async () => {
    const result = await callTool("propose_team_memory", { kind: "term", name: "OKR", detail: "The quarter's goals." }, context({
      client: {
        api: async () => ({ status: "applied", state: "applied", requestId: "entry-fixture", summary: "Term: OKR — The quarter's goals." }),
        apiResponse: async () => ({ ok: true, status: 200, body: {} }),
      },
    }));
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("Applied the team memory entry for OKR.");
    expect(result.text).not.toContain("confirmation card");
  });
});

describe("X research tools", () => {
  const ROUTES = { x_search: "search", x_user_posts: "user-posts", x_post: "post", x_profile: "profile" } as const;

  it("sends each tool's arguments to its route and returns the JSON the route gave", async () => {
    for (const [tool, route] of Object.entries(ROUTES)) {
      const calls: Array<{ path: string; body: unknown }> = [];
      const result = await callTool(tool, { query: "maus", handle: "@maus", post: "42" }, context({
        client: {
          api: async () => ({}),
          apiResponse: async (path, init) => {
            calls.push({ path, body: JSON.parse(String(init?.body)) });
            return { ok: true, status: 200, body: { posts: [{ id: "1" }], more: false } };
          },
        },
      }));
      expect(calls).toEqual([{ path: `/api/internal/x/${route}`, body: { query: "maus", handle: "@maus", post: "42" } }]);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.text)).toEqual({ posts: [{ id: "1" }], more: false });
    }
  });

  it("hands the bot the route's own sentence when it refuses", async () => {
    const result = await callTool("x_search", { query: "maus" }, context({
      client: {
        api: async () => ({}),
        apiResponse: async () => ({ ok: false, status: 403, body: { error: "X research is off for this bot. Turn it on in this bot's settings under Access." } }),
      },
    }));
    expect(result).toEqual({ text: "X research is off for this bot. Turn it on in this bot's settings under Access.", isError: true });
  });
});

describe("page tools", () => {
  it("send the tool's arguments to their internal routes and hand back the sentence, or the refusal as an error", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const answers = [{ ok: true, status: 200, body: { ok: true, text: "Published “Bake sale” at https://abcdefghijklmnopqrstuvwxyz.mausbot.page/" } },
      { ok: false, status: 402, body: { error: "You’ve used your 5 free pages. MausBot Cloud gives you more, and pages without the badge." } }];
    const client = { api: async () => ({}), apiResponse: async (path: string, init?: RequestInit) => { calls.push({ path, body: JSON.parse(String(init?.body)) }); return answers.shift()!; } };
    expect(await callTool("publish_page", { path: "site", title: "Bake sale" }, context({ client }))).toEqual({ text: "Published “Bake sale” at https://abcdefghijklmnopqrstuvwxyz.mausbot.page/" });
    expect(await callTool("unpublish_page", { page_id: "abcdefghijklmnopqrstuvwxyz" }, context({ client })))
      .toEqual({ text: "You’ve used your 5 free pages. MausBot Cloud gives you more, and pages without the badge.", isError: true });
    expect(calls).toEqual([{ path: "/api/internal/pages/publish", body: { path: "site", title: "Bake sale" } },
      { path: "/api/internal/pages/unpublish", body: { page_id: "abcdefghijklmnopqrstuvwxyz" } }]);
  });
});
