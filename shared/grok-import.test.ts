import { describe, expect, it } from "vitest";

import {
  GROK_EXPORT_PROMPT,
  GrokImportError,
  grokExportToPackage,
  grokShareIdFrom,
  grokStarterPackage,
  isGrokExport,
  nearestBotColor,
  parseGrokExport,
  grokMarketplaceSlugFrom,
  isGrokLink,
} from "./grok-import.ts";
import { parsePackageDocument } from "./package-format.ts";

const ID = "d8OshqLZvtcKDcNluPuyo";

const reply = {
  format: "openmaus.grok/1",
  source: "Grok Bot",
  name: "DOGE (Department of Grok Efficiency)",
  description: "Audits your other bots and routines and flags what to cut.",
  instructions: "You audit bots. Never change anything without a yes.\n\nReport in three bullets.",
  skills: [
    { name: "Audit Routines", description: "List routines to cut or merge.", body: "# Audit\n\nRead every routine and rank them." },
    { name: "bottlenecks", description: "", body: "---\nname: old-name\ndescription: Find slow steps\n---\n\nLook for waits." },
    { name: "empty", description: "Nothing here", body: "" },
  ],
  routines: [
    { name: "Weekly audit", schedule: "Mondays 9am", cron: "0 9 * * 1", timeZone: "America/New_York", prompt: "Audit everything." },
    { name: "Morning check", schedule: "Weekdays at 8:30am", cron: "", timeZone: "", prompt: "Say what changed." },
    { name: "On new PR", schedule: "When a GitHub pull request opens", cron: "", timeZone: "", prompt: "Review the PR." },
    { name: "Sometimes", schedule: "now and then, when it feels right", cron: "", timeZone: "", prompt: "Think." },
    { name: "Bad cron", schedule: "", cron: "99 99 * * *", timeZone: "UTC", prompt: "Never runs." },
  ],
  plugins: ["Gmail", "Google Calendar", { name: "Acme CRM", note: "Reads deals." }, "gmail"],
  memories: ["Prefers short answers.", "Works in IST."],
};

describe("grokShareIdFrom", () => {
  it("reads x.ai share links and the grokbot:// button link", () => {
    for (const link of [
      `https://x.ai/bot/${ID}`,
      `https://www.x.ai/bot/${ID}/`,
      `https://x.ai/bot/${ID}?utm_source=x`,
      `  x.ai/bot/${ID}  `,
      `grokbot://app/v1/bot-template?id=${ID}`,
    ]) expect(grokShareIdFrom(link), link).toBe(ID);
  });

  it("refuses other hosts, schemes, paths and ids", () => {
    for (const link of [
      `http://x.ai/bot/${ID}`,
      `https://x.ai.evil.example/bot/${ID}`,
      `https://evil.example/bot/${ID}`,
      `https://user:pw@x.ai/bot/${ID}`,
      `https://x.ai:8443/bot/${ID}`,
      `https://x.ai/bot/${ID}/edit`,
      "https://x.ai/bot/marketplace",
      `https://x.ai/b/${ID}`,
      `grokbot://app/v1/other?id=${ID}`,
      "grokbot://app/v1/bot-template?id=short",
      "",
      "not a link",
    ]) expect(grokShareIdFrom(link), link).toBeNull();
  });
});

describe("parseGrokExport", () => {
  it("reads a reply wrapped in a code fence and surrounding chat", () => {
    const text = `Here is my export:\n\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\`\n\nLet me know!`;
    const parsed = parseGrokExport(text);
    expect(parsed.format).toBe("openmaus.grok/1");
    expect(parsed.name).toBe(reply.name);
    expect(parsed.instructions).toBe(reply.instructions);
    expect(parsed.skills).toHaveLength(3);
    expect(parsed.routines[0]).toEqual({ name: "Weekly audit", schedule: "Mondays 9am", cron: "0 9 * * 1", timeZone: "America/New_York", prompt: "Audit everything." });
    expect(parsed.plugins.map((plugin) => plugin.name)).toEqual(["Gmail", "Google Calendar", "Acme CRM", "gmail"]);
    expect(parsed.memories).toEqual(reply.memories);
    expect(isGrokExport(text)).toBe(true);
  });

  it("reads a bare reply and a skill body that holds its own code fence", () => {
    const withFence = { ...reply, skills: [{ name: "fenced", description: "Has code", body: "Run:\n```sh\nls\n```\n" }] };
    expect(parseGrokExport(JSON.stringify(withFence)).skills[0]!.body).toContain("```sh");
    expect(parseGrokExport(`\uFEFF${JSON.stringify(reply)}`).name).toBe(reply.name);
  });

  it("reads pi-grokbot-import's grokbot-bundle/v1", () => {
    const bundle = {
      format: "grokbot-bundle/v1",
      exportedAt: "2026-10-07T14:41:05.241Z",
      source: { platform: "grok-bot", agentId: "4cb4dc74", url: `https://x.ai/bot/${ID}`, sharerName: "Sh1xu" },
      persona: { name: "Side", title: "", description: "One job: be the side chat.\n\nVoice: plain and short.", avatarColor: "#D94B52" },
      memories: [{ kind: "profile", text: "Calls the owner Sh1xu." }],
      skills: [{ name: "getting-started", description: "First conversation after import.", body: "# Getting started\n\nAsk one question at a time.\n" }],
      routines: [{ name: "morning-quiet-check", schedule: "47 8 * * 1-5", prompt: "Stay quiet unless useful." }],
      plugins: [{ id: "slack", note: "Posts the note" }],
      omitted: ["connector-secrets"],
    };
    const parsed = parseGrokExport(bundle);
    expect(parsed).toMatchObject({
      format: "grokbot-bundle/v1",
      name: "Side",
      instructions: bundle.persona.description,
      description: "One job: be the side chat.",
      creator: "Sh1xu",
      sourceUrl: `https://x.ai/bot/${ID}`,
      color: "#D94B52",
      memories: ["Calls the owner Sh1xu."],
    });
    const { document, leftOut } = grokExportToPackage(parsed, { timeZone: "Asia/Kolkata" });
    expect(leftOut).toEqual([]);
    expect(document.package.routines?.[0]?.schedule).toEqual({ type: "cron", expression: "47 8 * * 1-5", timeZone: "Asia/Kolkata" });
    expect(document.package.agents[0]!.appearance.color).toBe("red");
    expect(document.package.requirements.apps).toEqual([{ slug: "slack", label: "slack", reason: "Posts the note" }]);
  });

  it("refuses garbage with a sentence that says what to paste", () => {
    for (const input of ["", "hello there", "```json\n{not json}\n```", "[1,2,3]", 42, null, ["x"]]) {
      expect(() => parseGrokExport(input), String(input)).toThrow(GrokImportError);
    }
    expect(() => parseGrokExport("hello")).toThrow(/Copy the whole code block/);
    expect(() => parseGrokExport({ format: "openmaus.package", name: "x" })).toThrow("not a Grok Bot export");
    expect(() => parseGrokExport({ format: "openmaus.grok/1" })).toThrow("no name or instructions");
    expect(() => parseGrokExport("x".repeat(4 * 1024 * 1024 + 1))).toThrow("larger than 4 MB");
    expect(isGrokExport({ format: "openmaus.team" })).toBe(false);
  });
});

describe("grokExportToPackage", () => {
  const mapped = () => grokExportToPackage(parseGrokExport(reply), { sourceUrl: `https://www.x.ai/bot/${ID}?ref=1`, timeZone: "Europe/London" });

  it("makes one valid shared-team package with the standing instructions, credited to the share link", () => {
    const { document } = mapped();
    expect(() => parsePackageDocument(structuredClone(document))).not.toThrow();
    const pkg = document.package;
    expect(pkg.id).toMatch(/^doge-department-of-grok-efficiency-[0-9a-f]{6}$/);
    expect(pkg).toMatchObject({
      release: "1.0.0",
      name: reply.name,
      category: "Imported",
      license: "See source",
      setupMinutes: 5,
      author: { name: "Grok Bot creator", url: `https://x.ai/bot/${ID}` },
      team: { name: reply.name },
      summary: reply.description,
      tagline: reply.description,
    });
    expect(pkg.agents).toHaveLength(1);
    expect(pkg.agents[0]).toMatchObject({ key: "doge-department-of-grok-efficiency", name: reply.name, soul: reply.instructions, description: reply.description });
    expect(JSON.stringify(document)).not.toMatch(/"model"|modelSelection/);
    expect(grokExportToPackage(parseGrokExport(reply), { sourceUrl: `https://x.ai/bot/${ID}` }).document.package.id).toBe(pkg.id);
  });

  it("turns skills into SKILL.md entries the bot holds (they arrive off), dropping one with no text", () => {
    const { document, leftOut } = mapped();
    const entries = document.package.skills!.entries;
    expect(entries.map((skill) => skill.name)).toEqual(["audit-routines", "bottlenecks"]);
    expect(entries[0]!.instructions).toBe("---\nname: audit-routines\ndescription: List routines to cut or merge.\n---\n\n# Audit\n\nRead every routine and rank them.\n");
    // A body's own frontmatter is replaced; its description is kept when the export gave none.
    expect(entries[1]).toMatchObject({ description: "Find slow steps", instructions: "---\nname: bottlenecks\ndescription: Find slow steps\n---\n\nLook for waits.\n" });
    expect(document.package.agents[0]!.skills).toEqual(["audit-routines", "bottlenecks"]);
    expect(leftOut).toContainEqual({ kind: "skill", name: "Skill “empty”", reason: "the export had no text for it" });
  });

  it("keeps clock routines paused, and lists event and unreadable ones with their original text", () => {
    const { document, leftOut } = mapped();
    const routines = document.package.routines!;
    expect(routines.map((routine) => [routine.name, routine.schedule, routine.enabledAfterInstall, routine.runOn, routine.agent])).toEqual([
      ["Weekly audit", { type: "cron", expression: "0 9 * * 1", timeZone: "America/New_York" }, false, "maus", "doge-department-of-grok-efficiency"],
      ["Morning check", { type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] }, false, "maus", "doge-department-of-grok-efficiency"],
    ]);
    expect(leftOut).toContainEqual({
      kind: "routine",
      name: "Routine “On new PR”",
      reason: "it starts on an event, not a clock",
      original: "When: When a GitHub pull request opens\nReview the PR.",
    });
    expect(leftOut).toContainEqual({ kind: "routine", name: "Routine “Sometimes”", reason: "it starts on an event, not a clock", original: "When: now and then, when it feels right\nThink." });
    expect(leftOut).toContainEqual({ kind: "routine", name: "Routine “Bad cron”", reason: "its schedule could not be read", original: "Cron: 99 99 * * *\nNever runs." });
  });

  it("reads plain times and falls back to the person's zone", () => {
    const routine = (schedule: string, extra: Record<string, string> = {}) => {
      const { document, leftOut } = grokExportToPackage(
        parseGrokExport({ format: "openmaus.grok/1", name: "T", instructions: "x", routines: [{ name: "r", schedule, prompt: "p", ...extra }] }),
        { timeZone: "Asia/Kolkata" },
      );
      return document.package.routines?.[0]?.schedule ?? leftOut[0]?.reason;
    };
    expect(routine("Every day at 6pm")).toEqual({ type: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(routine("Tuesdays and Thursdays at 07:15")).toEqual({ type: "daily", time: "07:15", weekdays: [2, 4] });
    expect(routine("weekends at noon")).toEqual({ type: "daily", time: "12:00", weekdays: [0, 6] });
    expect(routine("every 2 hours")).toBe("its schedule could not be read");
    // An event routine stays out even when its words name a time.
    expect(routine("When an email arrives on weekdays at 9am")).toBe("it starts on an event, not a clock");
    expect(routine("")).toBe("the export gave no schedule for it");
    expect(routine("0 7 * * *", { timeZone: "Mars/Olympus" })).toEqual({ type: "cron", expression: "0 7 * * *", timeZone: "Asia/Kolkata" });
    expect(routine("weekdays at 9am", { cron: "not a cron" })).toEqual({ type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] });
  });

  it("lists apps as connector requirements, Composio slugs when known", () => {
    expect(mapped().document.package.requirements).toEqual({
      apps: [
        { slug: "gmail", label: "Gmail", reason: "DOGE (Department of Grok Efficiency) used Gmail in Grok Bot." },
        { slug: "googlecalendar", label: "Google Calendar", reason: "DOGE (Department of Grok Efficiency) used Google Calendar in Grok Bot." },
        { slug: "acme-crm", label: "Acme CRM", reason: "Reads deals." },
      ],
      capabilities: [],
    });
  });

  it("seeds memories only when the export has them", () => {
    expect(mapped().document.package.agents[0]!.seed).toEqual({
      memory: { "MEMORY.md": "# Notes from Grok Bot\n\n- Prefers short answers.\n- Works in IST.\n" },
    });
    const none = grokExportToPackage(parseGrokExport({ ...reply, memories: [] }));
    expect(none.document.package.agents[0]!.seed).toBeUndefined();
  });

  it("shortens instructions over the limit and says so", () => {
    const long = "é".repeat(13_000);
    const { document, leftOut } = grokExportToPackage(parseGrokExport({ ...reply, instructions: long }));
    expect(new TextEncoder().encode(document.package.agents[0]!.soul).length).toBeLessThanOrEqual(24_000);
    expect(document.package.agents[0]!.soul!.length).toBeGreaterThan(11_000);
    expect(leftOut[0]).toMatchObject({ name: "Standing instructions" });
    expect(leftOut[0]!.reason).toContain("24,000 bytes");
  });

  it("keeps at most 30 skills and 50 routines, and replaces key-shaped text", () => {
    const skills = Array.from({ length: 32 }, (_, index) => ({ name: `s${index}`, description: "d", body: "b" }));
    const routines = Array.from({ length: 52 }, (_, index) => ({ name: `r${index}`, cron: "0 9 * * *", timeZone: "UTC", prompt: "p" }));
    const { document, leftOut } = grokExportToPackage(parseGrokExport({
      ...reply, skills, routines, instructions: "Use sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 for calls.",
    }));
    expect(document.package.skills!.entries).toHaveLength(30);
    expect(document.package.routines).toHaveLength(50);
    expect(leftOut.filter((item) => item.reason === "a bot holds at most 30 skills")).toHaveLength(2);
    expect(leftOut.filter((item) => item.reason === "a package holds at most 50 routines")).toHaveLength(2);
    expect(document.package.agents[0]!.soul).not.toContain("sk-ant-");
    expect(leftOut.at(-1)).toMatchObject({ name: "Keys and passwords" });
  });
});

describe("grokStarterPackage", () => {
  it("writes instructions from the public description and credits the share link", () => {
    const document = grokStarterPackage({
      shareId: ID, name: "DOGE", creator: "Avid", description: "Audits your bots.", url: `https://x.ai/bot/${ID}`, color: "#FF9800",
    });
    expect(() => parsePackageDocument(structuredClone(document))).not.toThrow();
    const agent = document.package.agents[0]!;
    expect(agent.soul).toContain("What you do: Audits your bots.");
    expect(agent.soul).toContain(`x.ai/bot/${ID}`);
    expect(agent.description).toBe(`Audits your bots.\n\nBased on x.ai/bot/${ID} by Avid.`);
    expect(agent.appearance.color).toBe("orange");
    expect(document.package.author).toEqual({ name: "Avid", url: `https://x.ai/bot/${ID}` });
    expect(document.package.skills).toBeUndefined();
    expect(document.package.routines).toBeUndefined();
  });
});

describe("GROK_EXPORT_PROMPT", () => {
  it("asks for one JSON block with everything verbatim and nothing private", () => {
    expect(GROK_EXPORT_PROMPT).toContain("ONE JSON code block");
    expect(GROK_EXPORT_PROMPT).toContain('"format": "openmaus.grok/1"');
    expect(GROK_EXPORT_PROMPT).toMatch(/full standing instructions, word for word/);
    expect(GROK_EXPORT_PROMPT).toMatch(/five-field cron and its IANA time zone/);
    expect(GROK_EXPORT_PROMPT).toMatch(/Never include API keys, tokens, passwords, email addresses/);
    expect(GROK_EXPORT_PROMPT).toMatch(/customer data/);
    expect(GROK_EXPORT_PROMPT).toMatch(/Include memories: no$/);
    // The prompt's own example parses as an export once the placeholders are filled.
    expect(parseGrokExport(GROK_EXPORT_PROMPT).format).toBe("openmaus.grok/1");
  });
});

describe("nearestBotColor", () => {
  it("picks the closest bot colour and gives greys blue", () => {
    expect(nearestBotColor("#FF9800")).toBe("orange");
    expect(nearestBotColor("#d94b52")).toBe("red");
    expect(nearestBotColor("#0ea5c6")).toBe("cyan");
    expect(nearestBotColor("#000000")).toBe("blue");
    expect(nearestBotColor("oops")).toBe("blue");
    expect(nearestBotColor(undefined)).toBe("blue");
  });
});

describe("Grok Bot marketplace links", () => {
  it("reads the slug of an x.ai marketplace page, and nothing else", () => {
    expect(grokMarketplaceSlugFrom("https://x.ai/bot/marketplace/bots/overheard")).toBe("overheard");
    expect(grokMarketplaceSlugFrom("x.ai/bot/marketplace/bots/tradbot-2/")).toBe("tradbot-2");
    expect(grokMarketplaceSlugFrom("https://www.x.ai/bot/marketplace/bots/dr-eggbot-v2?ref=x")).toBe("dr-eggbot-v2");
    for (const bad of ["https://x.ai/bot/marketplace", "https://evil.test/bot/marketplace/bots/overheard", "http://x.ai/bot/marketplace/bots/overheard",
      "https://x.ai.evil.test/bot/marketplace/bots/overheard", "https://x.ai/bot/marketplace/bots/Over_Heard", "https://x.ai/bot/marketplace/bots/a/b"]) {
      expect(grokMarketplaceSlugFrom(bad), bad).toBeNull();
    }
    expect(isGrokLink("https://x.ai/bot/marketplace/bots/overheard")).toBe(true);
    expect(isGrokLink("https://x.ai/bot/NIEguoGUjA648fUPle8F5")).toBe(true);
    expect(isGrokLink("https://github.com/a/b/team.md")).toBe(false);
  });
});
