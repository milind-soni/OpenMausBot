import { describe, expect, it } from "vitest";

import { createBotPackageExport, createTeamPackageExport, shareableAddress, TEAM_TOO_LARGE_MESSAGE, TeamExportError } from "./package-export.ts";
import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import type { Routine } from "./routines.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import { includedSkills, requestedSkills, startingTicks } from "../src/lib/team-share-skills.ts";

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

  // The Share dialog's first look asks for "all". A team that cannot put
  // every skill in one file must still get a preview (and its skill boxes),
  // so "all" shares what fits and lists the rest instead of refusing.
  describe("skills that do not all fit", () => {
    const many = (prefix: string, count: number, extra: { enabled?: boolean } = {}) =>
      Array.from({ length: count }, (_, index) => ({ ...skill(`${prefix}-${String(index + 1).padStart(2, "0")}`), ...extra }));
    const conflicting = { ...skill("pricing"), instructions: "---\nname: pricing\ndescription: pricing description\n---\n\n# Another pricing\n" };

    it("keeps 30 per bot, switched-on skills first, and lists the rest", () => {
      const input = { ...fixture(), skillSelection: "all" as const,
        skillsByBot: new Map([["lead", [{ ...skill("a-off"), enabled: false }, ...many("s", 30, { enabled: true })]]]) };
      const result = createTeamPackageExport(input);
      const lead = result.document.package.agents.find((agent) => agent.key === "morgan")!;
      expect(lead.skills).toHaveLength(30);
      expect(lead.skills).not.toContain("a-off");
      expect(result.document.package.skills?.entries.map((entry) => entry.name)).not.toContain("a-off");
      expect(JSON.stringify(result.document)).not.toContain('"enabled"');
      expect(result.skipped).toContainEqual({ part: "agents[morgan].skills[a-off]", reason: "bot_skill_limit" });
    });

    it("leaves out a name two bots hold with different content, whole", () => {
      const result = createTeamPackageExport({ ...fixture(), skillSelection: "all",
        skillsByBot: new Map([["lead", [skill("pricing")]], ["scout", [conflicting, skill("research")]]]) });
      expect(result.document.package.skills?.entries.map((entry) => entry.name)).toEqual(["research"]);
      expect(result.document.package.agents.map((agent) => agent.skills)).toEqual([undefined, ["research"]]);
      expect(result.skipped).toContainEqual({ part: "skills[pricing]", reason: "skill_conflict" });
    });

    it("keeps 60 per team and lists the rest", () => {
      const input = fixture();
      input.bots.push(bot("third", "Third"));
      const result = createTeamPackageExport({ ...input, skillSelection: "all",
        skillsByBot: new Map([["lead", many("a", 30)], ["scout", many("b", 30)], ["third", many("c", 2)]]) });
      expect(result.document.package.skills?.entries).toHaveLength(60);
      expect(result.skipped.filter((skip) => skip.reason === "team_skill_limit")).toEqual([
        { part: "skills[c-01]", reason: "team_skill_limit" }, { part: "skills[c-02]", reason: "team_skill_limit" },
      ]);
      expect(result.document.package.agents.find((agent) => agent.key === "third")?.skills).toBeUndefined();
    });

    it("keeps switched-on skills first when the team has more than 60, even one that sorts later by name", () => {
      const input = fixture();
      input.bots.push(bot("third", "Third"));
      // 61 names: "a-off" sorts first by name but is switched off on the only
      // bot that has it; "b-01" is off on Third but on for Morgan, so it counts as on.
      const result = createTeamPackageExport({ ...input, skillSelection: "all",
        skillsByBot: new Map([["lead", many("b", 30, { enabled: true })], ["scout", many("c", 30, { enabled: true })],
          ["third", [{ ...skill("a-off"), enabled: false }, { ...skill("b-01"), enabled: false }]]]) });
      const kept = result.document.package.skills?.entries.map((entry) => entry.name);
      expect(kept).toHaveLength(60);
      expect(kept).not.toContain("a-off");
      expect(kept).toContain("c-30");
      expect(result.skipped.filter((skip) => skip.reason === "team_skill_limit")).toEqual([{ part: "skills[a-off]", reason: "team_skill_limit" }]);
      expect(result.document.package.agents.find((agent) => agent.key === "third")?.skills).toEqual(["b-01"]);
    });

    it("starts the dialog's boxes on a choice that fits, so unticking any one box still fits", () => {
      // Morgan holds s-01…s-31; Scout holds the same s-31 plus z-only. "all"
      // puts all 32 names in the file (s-31 for Scout only).
      const shared = many("s", 31);
      const skillsByBot = new Map([["lead", shared], ["scout", [shared[30]!, skill("z-only")]]]);
      const all = createTeamPackageExport({ ...fixture(), skillSelection: "all", skillsByBot });
      expect(includedSkills(all.document)).toHaveLength(32);
      const exactly = (names: readonly string[]) => createTeamPackageExport({ ...fixture(),
        skillsByBot: new Map([...skillsByBot].map(([id, list]) => [id, list.filter((entry) => names.includes(entry.name))])) });
      // Ticking what the file holds would refuse after unticking z-only.
      expect(() => exactly(includedSkills(all.document).filter((name) => name !== "z-only"))).toThrow("Morgan has more than 30 skills");
      const ticks = startingTicks(all);
      expect(ticks).not.toContain("s-31");
      expect(() => exactly(ticks)).not.toThrow();
      for (const unticked of ticks) {
        const choice = requestedSkills(new Set(ticks.filter((name) => name !== unticked)), [...shared.map((entry) => entry.name), "z-only"]);
        expect(() => exactly(choice as string[])).not.toThrow();
      }
    });

    it("refuses an exact choice that cannot fit, in a sentence the dialog shows", () => {
      const refusal = (skillsByBot: Map<string, ReturnType<typeof skill>[]>) => {
        try {
          createTeamPackageExport({ ...fixture(), skillsByBot });
        } catch (error) {
          return error;
        }
        throw new Error("expected a refusal");
      };
      const crowded = refusal(new Map([["lead", many("s", 31)]]));
      expect(crowded).toBeInstanceOf(TeamExportError);
      expect((crowded as Error).message).toBe("Morgan has more than 30 skills. Choose fewer skills and try again.");
      const conflict = refusal(new Map([["lead", [skill("pricing")]], ["scout", [conflicting]]]));
      expect(conflict).toBeInstanceOf(TeamExportError);
      expect((conflict as Error).message).toBe('Two bots in this team have different skills named "pricing". Leave that skill out and try again.');
    });
  });

  describe("connection addresses", () => {
    it.each([
      ["a Zapier token segment", "https://mcp.zapier.com/api/mcp/s/NjQ5YjM0ZDgtN2E4Mi00ZDM0LWI1ZjYtOTU2ZGUxYjM3ZTQ5OjE2YjQ3M2Q4==/mcp",
        "https://mcp.zapier.com/api/mcp/s/redacted/mcp"],
      ["query values and the fragment", "https://host.example/sse?key=abcd1234efgh5678&profile=default#frag", "https://host.example/sse?key=&profile="],
      ["a server UUID", "https://mcp.composio.dev/composio/server/3fa85f64-5717-4562-b3fc-2c963f66afa6/mcp",
        "https://mcp.composio.dev/composio/server/redacted/mcp"],
      ["a sign-in part", "https://user:pass1234@host.example/mcp", "https://host.example/mcp"],
      ["a key in the subdomain", "https://a1b2c3d4e5f6g7h8i9j0k1l2.mcp.example.com/mcp", "https://redacted.mcp.example.com/mcp"],
      ["a short hex key", "https://host.example/s/a1b2c3d4e5f6a7b8/", "https://host.example/s/redacted/"],
      ["a short key after key=", "https://host.example/key=abcdef12345678/", "https://host.example/key=/"],
      ["24 letters in a row", "https://host.example/s/abcdefghijklmnopqrstuvwxyz/mcp", "https://host.example/s/redacted/mcp"],
      ["24 digits in a row", "https://host.example/s/123456789012345678901234/mcp", "https://host.example/s/redacted/mcp"],
      ...[":", "@", "!", "$", "'", "(", ")", "*", ","].map((mark) => [`a key after "${mark}" in a segment`,
        `https://host.example/s/abc${mark}def1234567890123456789/`, "https://host.example/s/redacted/"]),
      ["a matrix parameter value", "https://host.example/mcp;key=abcdef1234567890abcdef", "https://host.example/mcp;key="],
      ["a key-shaped matrix parameter name", "https://host.example/mcp;sk_live_abcdef1234567890abcdef", "https://host.example/redacted"],
      ["a key used as a query name", "https://host.example/mcp?sk_live_abcdef1234567890abcdef", "https://host.example/mcp?redacted="],
      ["a key escaped character by character", `https://host.example/s/${[..."abcdef1234567890"].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}/mcp`,
        "https://host.example/s/redacted/mcp"],
    ])("never carries %s", (_case, address, shared) => {
      expect(shareableAddress(address)).toEqual({ url: shared, changed: true });
    });

    it.each([
      "https://mcp.example.com/crm",
      "https://mcp.example.com",
      "https://api.example.com/v1/github-mcp-server/sse?",
      "https://api.example.com/github-mcp-server-2024/sse",
      "https://api.example.com/acme-corp-2025-sales/mcp",
      "https://api.example.com/docs/path%20with%20spaces/mcp",
      "https://api.example.com/reports/quarterly%20sales%20by%20region%202025/mcp",
      "https://acme-corp-2025-sales.mcp.example.com/sse",
      "https://mcp.a1b2c3d4e5f6g7h8i9j0.com/mcp",
      "https://server.smithery.ai/@smithery-ai/github/mcp?profile",
      "https://api.example.com/v2/oauth2/mcp_server_v2/sse",
      "http://127.0.0.1:3000/sse",
      "http://localhost:8080/mcp",
    ])("keeps a plain address exactly: %s", (plain) => {
      expect(shareableAddress(plain)).toEqual({ url: plain, changed: false });
    });

    it("reports a changed address as redacted and exports it without the key", () => {
      const input = fixture();
      input.mcpServers.crm = { ...input.mcpServers.crm, url: "https://mcp.zapier.com/api/mcp/s/ZTJmNDk1YjMtNjQ0Yi00ZjU2/mcp?token=abcdef" };
      const result = createTeamPackageExport(input);
      expect(result.document.package.connections?.[0]?.mcp.url).toBe("https://mcp.zapier.com/api/mcp/s/redacted/mcp?token=");
      expect(result.redacted).toEqual(["connections[crm].mcp.url"]);
      expect(JSON.stringify(result.document)).not.toMatch(/ZTJmNDk1YjMtNjQ0Yi00ZjU2|abcdef/);
    });
  });
});
