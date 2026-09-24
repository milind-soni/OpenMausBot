import { describe, expect, it } from "vitest";

import { createBotPackageExport, createTeamPackageExport, TEAM_TOO_LARGE_MESSAGE } from "./package-export.ts";
import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import type { Routine } from "./routines.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

describe("package export", () => {
  it("preserves the exact cron and timezone through export and import", () => {
    const schedule = { type: "cron" as const, expression: "0 9 L * *", timeZone: "America/New_York" };
    const exported = createBotPackageExport({
      name: "Monthly team", authorName: "Tester", groups: [],
      bots: [{ id: "b1", threadId: "t1", name: "Lead", color: "green", createdAt: 1 } as BotRecord],
      routines: [{ id: "r1", name: "Close the month", prompt: "Prepare a report", target: "bot", botId: "b1",
        runOn: "maus", enabled: true, schedule, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1,
        overlap: "queue", skippedRuns: 4, lastSkippedAt: 1, failureStreak: 2 }],
    });
    expect(exported.package.routines?.[0]).toMatchObject({ schedule, enabledAfterInstall: false });
    expect(parseBotPackage(renderBotPackageMarkdown(exported)).package.routines?.[0]?.schedule).toEqual(schedule);
    const imported = parseBotPackage(renderBotPackageMarkdown(exported)).package.routines?.[0];
    expect(imported?.overlap).toBe("queue");
    expect(imported).not.toHaveProperty("skippedRuns");
    expect(imported).not.toHaveProperty("lastSkippedAt");
    expect(imported).not.toHaveProperty("failureStreak");
  });

  it("keeps collaboration structure while excluding runtime authority and state", () => {
    const exported = createBotPackageExport({
      name: "Launch Crew",
      authorName: "Mira",
      bots: [
        {
          id: "private-id",
          threadId: "private-thread",
          name: "Lead",
          title: "Chief",
          description: "Coordinates",
          soul: "Preserve the mission.\n",
          notifications: true,
          color: "purple",
          unread: false,
          modelSelection: { instanceId: "private-engine", model: "secret-model", effort: "medium" },
          resumeCursors: { provider: "secret-session" },
          chiefOfStaff: true,
          composio: true,
          connectorTools: { gmail: { tools: "*" } },
          cwd: "/private/path",
          approvalMode: "full",
          autoApprove: true,
          alwaysAllow: ["everything"],
          installedPackage: {
            id: "source",
            name: "Source",
            release: "1.0.0",
            requiredApps: [{ slug: "github", label: "GitHub", reason: "Read repositories.", optional: true }],
          },
          playbooks: [{ key: "launch", name: "Launch", summary: "Ship", triggers: ["launch plan"], instructions: "Verify the release." }],
          createdAt: 1,
        },
      ],
      groups: [{
        id: "private-room-id",
        threadId: "private-room-thread",
        name: "Launch Room",
        memberIds: ["private-id"],
        defaultResponder: { kind: "member", botId: "private-id" },
        bulletin: "Ship carefully.",
        unread: false,
        createdAt: 1,
      }],
      routines: [
        {
          id: "private-routine-id",
          name: "Release check",
          prompt: "Verify release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: { type: "daily", time: "09:00", weekdays: [1] },
          durationMinutes: 30,
          attachments: [{
            id: "private-attachment",
            kind: "file",
            name: "private.txt",
            path: "/private/calendar/context.txt",
            size: 42,
          }],
          nextRunAt: 123,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-room-routine-id",
          name: "Team release review",
          prompt: "Review the release together.",
          target: "room-goal",
          groupId: "private-room-id",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: { type: "daily", time: "10:00", weekdays: [1] },
          durationMinutes: 30,
          nextRunAt: 456,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-interval-routine-id",
          name: "Frequent release check",
          prompt: "Watch release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: {
            type: "interval",
            everyMinutes: 15,
            anchorAt: 1_788_254_400_000,
            weekdays: [1, 3, 5],
            window: { start: "09:00", end: "17:00" },
            endsAt: 1_790_843_400_000,
          },
          durationMinutes: 30,
          timeoutMinutes: 20,
          nextRunAt: 789,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      skillsByBot: new Map([[
        "private-id",
        [{
          name: "source-check",
          description: "Check sources.",
          source: "conversation:source-check",
          instructions: "---\nname: source-check\ndescription: Check sources.\n---\n\n# Source check\n",
        }],
      ]]),
    });
    expect(exported.package.routines).toHaveLength(2);
    expect(exported.package.agents[0].soul).toBe("Preserve the mission.\n");
    expect(exported.package.routines?.[1]?.schedule).toEqual({
      type: "interval",
      everyMinutes: 15,
      anchorAt: 1_788_254_400_000,
      weekdays: [1, 3, 5],
      window: { start: "09:00", end: "17:00" },
      endsAt: 1_790_843_400_000,
    });
    expect(exported.package.routines?.[1]?.timeoutMinutes).toBe(20);

    expect(exported).toMatchObject({
      format: "openmaus.package",
      package: {
        chiefOfStaff: "lead",
        requirements: { apps: [{ slug: "github" }] },
        rooms: [{ members: ["lead"], defaultResponder: { kind: "agent", agent: "lead" } }],
        routines: [
          { agent: "lead", enabledAfterInstall: false },
          { agent: "lead", enabledAfterInstall: false },
        ],
        playbooks: [{ key: "launch" }],
        skills: { entries: [{ name: "source-check" }] },
        agents: [{ skills: ["source-check"] }],
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(/private-id|private-thread|private-engine|secret-model|secret-session|private\/path|private-attachment|approvalMode|autoApprove|alwaysAllow|connectorTools|nextRunAt/);
  });

  it.each([
    { instructions: "---\nname: shared\ndescription: Shared\n---\ntwo" },
    { description: "Different" }, { source: "other" }, { license: "MIT" }, { compatibility: "Other" },
  ])("refuses conflicting portable skill content across selected bots: %j", (patch) => {
    const bot = (id: string): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name: id,
      title: "Researcher",
      description: "Researches leads",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      createdAt: 1,
    });
    expect(() => createBotPackageExport({
      name: "Conflicting Skills",
      bots: [bot("one"), bot("two")],
      groups: [],
      routines: [],
      skillsByBot: new Map([
        ["one", [{ name: "shared", description: "Shared", instructions: "---\nname: shared\ndescription: Shared\n---\none" }]],
        ["two", [{ name: "shared", description: "Shared", instructions: "---\nname: shared\ndescription: Shared\n---\none", ...patch }]],
      ]),
    })).toThrow("conflicting content");
  });

  it("shares one identical playbook definition across multiple bots", () => {
    const sharedPlaybook = {
      key: "qualify",
      name: "Qualify",
      summary: "Check fit",
      triggers: ["qualify lead"],
      instructions: "Check the lead against the stated criteria.",
    };
    const bot = (id: string, name: string): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name,
      title: "Researcher",
      description: "Researches leads",
      notifications: true,
      color: "green" as const,
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      playbooks: [sharedPlaybook],
      createdAt: 1,
    });

    const exported = createBotPackageExport({
      name: "Lead Crew",
      bots: [bot("one", "Scout"), bot("two", "Reviewer")],
      groups: [],
      routines: [],
    });

    expect(exported.package.playbooks).toHaveLength(1);
    expect(exported.package.agents.map((agent) => agent.playbooks)).toEqual([
      ["qualify"],
      ["qualify"],
    ]);
  });

});

describe("whole-team export (package v2)", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const bot = (id: string, name: string, extra: Partial<BotRecord> = {}): BotRecord => ({
    id, threadId: `thread-${id}`, name, title: `${name} title`, description: `${name} description`,
    notifications: true, color: "green", unread: false,
    modelSelection: { instanceId: "private-engine", model: "secret-model" }, resumeCursors: { provider: "secret-session" },
    createdAt: 1, section: "Sales desk", ...extra,
  });
  const room = (id: string, name: string, memberIds: string[], extra: Partial<GroupRecord> = {}): GroupRecord => ({
    id, threadId: `room-thread-${id}`, name, memberIds, defaultResponder: { kind: "mentions" }, bulletin: "",
    unread: false, createdAt: 1, section: "Sales desk", ...extra,
  });
  const routine = (id: string, name: string, botId: string, extra: Partial<Routine> = {}): Routine => ({
    id, name, prompt: `${name} prompt`, target: "bot", botId, runOn: "maus", enabled: true,
    schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 30, nextRunAt: 5, createdAt: 1, updatedAt: 1, ...extra,
  });
  const skill = (name: string) => ({
    name, description: `${name} description`, instructions: `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
  });
  const fixture = () => {
    const bots = [
      bot("lead", "Morgan", { chiefOfStaff: true, soul: "Coordinate the desk.\n", avatarUrl: "/api/attachments/a.png", avatarCrop: "rounded",
        mcpServers: ["crm", "local-tool", "plain-http"], playbooks: [{ key: "qualify", name: "Qualify", summary: "Check fit", triggers: ["qualify"], instructions: "Ask four questions." }] }),
      bot("scout", "Scout", { mcpServers: ["crm"] }),
      bot("hidden", "Archived", { hidden: true }),
      bot("other", "Elsewhere", { section: "Support" }),
    ];
    const groups = [
      room("desk", "Deal desk", ["lead", "scout", "other", "hidden"], { defaultResponder: { kind: "member", botId: "lead" }, bulletin: "Cite sources." }),
      room("support-room", "Support room", ["other"], { section: "Support" }),
      room("dm", "DM", ["lead", "scout"], { dm: true }),
      room("foreign-only", "Only outsiders", ["other"]),
    ];
    const routines = [
      routine("digest", "Daily digest", "scout", { continuity: true, attachments: [{ id: "a", kind: "file", name: "x.txt", path: "/private/x.txt", size: 1 }] }),
      routine("review", "Weekly review", "lead", { target: "room-goal", groupId: "desk", enabled: false }),
      routine("elsewhere", "Support digest", "other"),
    ];
    return {
      team: "Sales desk", authorName: "Mira", bots, groups, routines, published: null,
      brief: "Quote list prices only.",
      skillsByBot: new Map([["lead", [skill("pricing")]], ["scout", [skill("pricing"), skill("research")]]]),
      mcpServers: {
        crm: { type: "http", url: "https://mcp.example.com/crm", headers: { Authorization: "Bearer real-value-never-shared" }, enabled: true },
        "local-tool": { command: "npx", args: ["tool"], env: { TOKEN: "x" }, enabled: true },
        "plain-http": { type: "http", url: "http://mcp.example.com", enabled: true },
      },
      avatars: { lead: `data:image/png;base64,${PNG}` },
    };
  };

  it("exports only the chosen team, whole, without chat history or authority", () => {
    const result = createTeamPackageExport(fixture());
    const pkg = result.document.package;
    expect(result.document).toMatchObject({ format: "openmaus.package", version: 2 });
    expect(pkg.agents.map((agent) => agent.key)).toEqual(["morgan", "scout"]);
    expect(pkg.team).toEqual({ name: "Sales desk", brief: "Quote list prices only.", leader: "morgan" });
    expect(pkg.agents[0]).toMatchObject({
      name: "Morgan", soul: "Coordinate the desk.\n", playbooks: ["qualify"], skills: ["pricing"], connections: ["crm"],
      appearance: { color: "green", avatar: { mime: "image/png", data: PNG, crop: "rounded" } },
    });
    expect(pkg.rooms).toEqual([{ key: "deal-desk", name: "Deal desk", members: ["morgan", "scout"], bulletin: "Cite sources.",
      defaultResponder: { kind: "agent", agent: "morgan" } }]);
    expect(pkg.routines).toEqual([
      expect.objectContaining({ key: "daily-digest", agent: "scout", continuity: true, enabledAfterInstall: true }),
      expect.objectContaining({ key: "weekly-review", agent: "morgan", room: "deal-desk", runOn: "maus", enabledAfterInstall: false }),
    ]);
    expect(pkg.connections).toEqual([{ key: "crm", label: "crm", reason: "Used by Morgan, Scout",
      mcp: { transport: "http", url: "https://mcp.example.com/crm", valueNames: ["Authorization"] } }]);
    expect(pkg.skills?.entries.map((entry) => entry.name)).toEqual(["pricing", "research"]);
    const text = JSON.stringify(result.document);
    expect(text).not.toMatch(/Archived|Elsewhere|Support|Only outsiders|"DM"|real-value-never-shared|secret-model|secret-session|thread-|private\/x\.txt|"seed"/);
    expect(result.skipped).toEqual([
      { part: "connections[local-tool]", reason: "stdio_server" },
      { part: "connections[plain-http]", reason: "insecure_address" },
      { part: "routines[daily-digest].attachments", reason: "files_not_shared" },
    ]);
    expect(result.filename).toBe("sales-desk-1.0.0.openmaus.json");
  });

  it("adds starter notes only when asked, within the caps", () => {
    expect(createTeamPackageExport(fixture()).document.package.agents.some((agent) => agent.seed)).toBe(false);
    const withNotes = createTeamPackageExport({ ...fixture(), memoryByBot: new Map([["lead", [
      { path: "MEMORY.md", text: "- Prefers short answers.\n" },
      { path: "memory/pricing.md", text: "List price 49.\n" },
      { path: "memory/huge.md", text: "x".repeat(300 * 1024) },
      { path: "memory/empty.md", text: "   " },
    ]]]) });
    expect(withNotes.document.package.agents[0]?.seed).toEqual({ memory: { "MEMORY.md": "- Prefers short answers.\n", "memory/pricing.md": "List price 49.\n" } });
    expect(withNotes.skipped).toContainEqual({ part: 'agents[morgan].seed.memory["memory/huge.md"]', reason: "notes_too_large" });
  });

  it("removes secrets from text and says where", () => {
    const input = fixture();
    input.bots[1] = { ...input.bots[1]!, soul: "Log in with password=hunter2hunter2 first." };
    const result = createTeamPackageExport(input);
    expect(result.redacted).toEqual(["agents[scout].soul"]);
    expect(JSON.stringify(result.document)).not.toContain("hunter2hunter2");
  });

  it("skips pictures that are too large or not what they claim", () => {
    const big = new Uint8Array(70 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tooLarge = createTeamPackageExport({ ...fixture(), avatars: { lead: `data:image/png;base64,${Buffer.from(big).toString("base64")}`, scout: `data:image/webp;base64,${PNG}` } });
    expect(tooLarge.skipped).toEqual(expect.arrayContaining([
      { part: "agents[morgan].appearance.avatar", reason: "picture_too_large" },
      { part: "agents[scout].appearance.avatar", reason: "picture_invalid" },
    ]));
    expect(tooLarge.document.package.agents.some((agent) => agent.appearance.avatar)).toBe(false);
    const gif = createTeamPackageExport({ ...fixture(), avatars: { lead: `data:image/gif;base64,R0lGODlhAQABAAAAACw=` } });
    expect(gif.skipped).toContainEqual({ part: "agents[morgan].appearance.avatar", reason: "picture_invalid" });
  });

  it("keeps every key after renaming a bot, a group chat, a routine and the team", () => {
    const first = createTeamPackageExport(fixture());
    const renamed = fixture();
    renamed.team = "Revenue desk";
    for (const record of [...renamed.bots, ...renamed.groups]) if (record.section === "Sales desk") record.section = "Revenue desk";
    renamed.bots[0] = { ...renamed.bots[0]!, name: "Morgan Lee" };
    renamed.groups[0] = { ...renamed.groups[0]!, name: "Pipeline room" };
    renamed.routines[0] = { ...renamed.routines[0]!, name: "Morning digest" };
    const second = createTeamPackageExport({ ...renamed, published: first.published });
    expect(second.document.package.id).toBe("sales-desk");
    expect(second.document.package.release).toBe("1.0.1");
    expect(second.document.package.agents.map((agent) => agent.key)).toEqual(["morgan", "scout"]);
    expect(second.document.package.rooms?.map((room) => room.key)).toEqual(["deal-desk"]);
    expect(second.document.package.routines?.map((routine) => routine.key)).toEqual(["daily-digest", "weekly-review"]);
    expect(second.filename).toBe("sales-desk-1.0.1.openmaus.json");
  });

  it("never gives a new bot a key recorded for one that left", () => {
    const first = createTeamPackageExport(fixture());
    const input = fixture();
    input.bots[1] = { ...input.bots[1]!, section: "Support" };
    input.bots.push(bot("newcomer", "Scout"));
    const second = createTeamPackageExport({ ...input, published: first.published });
    expect(second.document.package.agents.map((agent) => agent.key)).toEqual(["morgan", "scout-2"]);
    expect(second.published.keys.bots).toMatchObject({ scout: "scout", newcomer: "scout-2" });
  });

  it("starts from the release a team was installed from", () => {
    const input = fixture();
    input.bots = input.bots.map((record) => record.section === "Sales desk" && !record.hidden
      ? { ...record, installedPackage: { id: "acme-sales", name: "Acme sales", release: "2.4.0", requiredApps: [], agentKey: record.id === "lead" ? "boss" : "finder" } }
      : record);
    const result = createTeamPackageExport(input);
    expect(result.document.package.id).toBe("acme-sales");
    expect(result.document.package.agents.map((agent) => agent.key)).toEqual(["boss", "finder"]);
  });

  it("refuses plainly when there is nothing to share, a bad version or too much", () => {
    expect(() => createTeamPackageExport({ ...fixture(), team: "Empty" })).toThrow("Add a bot to this team before sharing it.");
    expect(() => createTeamPackageExport({ ...fixture(), release: "one" })).toThrow("Use a version like 1.2.3.");
    const huge = fixture();
    huge.skillsByBot = new Map([["lead", Array.from({ length: 17 }, (_, index) => ({
      ...skill(`big-${index}`), instructions: `---\nname: big-${index}\ndescription: big-${index} description\n---\n${"a".repeat(250_000)}`,
    }))]]);
    expect(() => createTeamPackageExport(huge)).toThrow(TEAM_TOO_LARGE_MESSAGE);
  });
});
