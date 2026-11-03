import { describe, expect, it } from "vitest";

import { GROK_EXPORT_FORMAT, GROK_EXPORT_PROMPT, GrokImportError, grokMovePlan, grokRedactions, mergeGrokBots, parseGrokExport, routinesLeftOut, type GrokBot } from "./grok-import.ts";
import { parsePackageDocument } from "./package-format.ts";

const TOKEN = "sk-abcdefghijklmnopqrstuvwx";
/** The shape a real Bot wrote: role, memories, facts, skills, a live and a paused routine, event routines, apps. */
const BOT = {
  name: "Account Health", title: "Customer success",
  instructions: "Own the weekly account-health review. Never contact a customer without approval.",
  memories: ["Churn signal: three weeks without a login", `Token ${TOKEN} is old`, "churn signal:  three WEEKS without a login"],
  user_facts: ["Works in America/New_York", "Churn signal: three weeks without a login"],
  skills: [
    { name: "Weekly account health", description: "Score accounts each week", instructions: "1. Pull usage.\n2. Flag churn.\n3. Post a watch list." },
    { name: "Empty one", description: "", instructions: "" },
  ],
  routines: [
    { name: "Morning watch list", instruction: "Run the Weekly account health skill.", trigger: "schedule", schedule_cron: "0 8 * * 1-5", schedule_text: "Every weekday at 8:00 AM", timezone: "America/New_York", paused: false, skills: ["Weekly account health"] },
    { name: "Monday check", instruction: "Check Monday things.", trigger: "schedule", schedule_cron: "49 8 * * 1", schedule_text: "Mondays", timezone: "America/Los_Angeles", paused: true },
    { name: "Escalations", instruction: `Reproduce the ticket. Key ${TOKEN}.`, trigger: "slack", trigger_details: "#customer-escalations, phrase 'needs repro'" },
    { name: "Order hook", instruction: "File the order.", trigger: "webhook", trigger_details: "from the shop" },
  ],
  apps: [
    { name: "Linear", mcp_url: "https://mcp.linear.app/mcp", header_names: ["Authorization"] },
    { name: "Gmail", mcp_url: "" },
  ],
};
const EXPORT = { format: GROK_EXPORT_FORMAT, version: 1, bots: [BOT] };
const FILE = JSON.stringify(EXPORT, null, 2);
const plan = (bot: unknown = BOT) => grokMovePlan(parseGrokExport(JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [bot] }))[0]!, { timeZone: "Europe/Berlin" });
const refused = (input: unknown) => {
  try {
    parseGrokExport(typeof input === "string" ? input : JSON.stringify(input));
  } catch (cause) {
    return cause as GrokImportError;
  }
  throw new Error("not refused");
};

describe("reading what a Bot wrote", () => {
  it("reads the file, a fenced reply and chat text around it, the same", () => {
    const fenced = `Here is my export:\n\n\`\`\`json\n${FILE}\n\`\`\`\n\nI left nothing out.`;
    const chatty = `Sure {thing}! ${FILE} Let me know, "ok"?`;
    for (const text of [FILE, fenced, chatty, `﻿${FILE}`]) {
      const bots = parseGrokExport(text);
      expect(bots.map((bot) => bot.name)).toEqual(["Account Health"]);
      expect(bots[0]!.routines).toHaveLength(4);
    }
  });

  it("joins an export split over two blocks and imports an exact repeat once", () => {
    const part = (extra: object) => JSON.stringify({ format: GROK_EXPORT_FORMAT, version: 1, bots: [{ name: "Desk", ...extra }] });
    const routine = { name: "Reminder", instruction: "Say it.", schedule_cron: "0 9 * * *" };
    const reply = `\`\`\`json\n${part({ instructions: "Run the desk.", routines: [routine] })}\n\`\`\`\nmore:\n\`\`\`json\n${part({ routines: [routine, { ...routine, instruction: "Say another." }] })}\n\`\`\``;
    const [bot] = parseGrokExport(reply);
    expect(bot!.instructions).toBe("Run the desk.");
    expect(bot!.routines.map((item) => item.instruction)).toEqual(["Say it.", "Say another."]);
  });

  it("keeps two Bots apart and reads an instruction with a fence-like run and braces in it", () => {
    const text = JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [{ name: "A", instructions: "Use ```code``` and {braces}." }, { name: "B", instructions: "b" }] });
    const bots = parseGrokExport(`Done.\n${text}`);
    expect(bots.map((bot) => bot.name)).toEqual(["A", "B"]);
    expect(bots[0]!.instructions).toContain("{braces}");
  });

  it("repairs curly quotes and trailing commas, without touching a comma in a string", () => {
    const text = `{ “format”: “${GROK_EXPORT_FORMAT}”, “bots”: [ { “name”: “Desk”, “instructions”: “One, two,”, }, ], }`;
    expect(parseGrokExport(text)[0]!.instructions).toBe("One, two,");
  });

  it("ignores an example list in a reply, and says plainly when nothing or half of it came", () => {
    expect(refused('Example: ```json\n{"routines":[{"name":"x"}]}\n```').code).toBe("notExport");
    expect(refused("thanks, done!").code).toBe("notExport");
    expect(refused(FILE.slice(0, 300)).code).toBe("cutOff");
    expect(refused({ format: GROK_EXPORT_FORMAT, version: 2, bots: [{ name: "x" }] }).code).toBe("newerVersion");
  });

  it("reads a bare Bot file, and the earlier openmaus.grok/1 export", () => {
    expect(parseGrokExport(JSON.stringify({ name: "Bare", instructions: "x" }))[0]!.name).toBe("Bare");
    const old = {
      format: "openmaus.grok/1", source: "Grok Bot", name: "Old", description: "Does things.", instructions: "Be old.",
      skills: [{ name: "s", description: "d", body: "the body" }],
      routines: [{ name: "r", schedule: "weekdays at 9am", cron: "", timeZone: "Asia/Tokyo", prompt: "Go." }],
      plugins: ["Slack"], memories: ["a"],
    };
    const [bot] = parseGrokExport(`\`\`\`json\n${JSON.stringify(old)}\n\`\`\``);
    expect(bot).toMatchObject({ name: "Old", instructions: "Be old.", memories: ["a"] });
    const moved = grokMovePlan(bot!, { timeZone: "UTC" });
    expect(moved.skills).toEqual(["s"]);
    expect(moved.routines.map((routine) => routine.name)).toEqual(["r"]);
    expect(moved.apps).toEqual(["Slack"]);
  });

  it("asks the Bot for no secrets and names the file per Bot", () => {
    expect(GROK_EXPORT_PROMPT).toContain(GROK_EXPORT_FORMAT);
    expect(GROK_EXPORT_PROMPT).toContain("grok-bot-export-<your name>.json");
    expect(GROK_EXPORT_PROMPT).toMatch(/Never include passwords, API keys, tokens/);
  });
});

describe("what an export may never bring", () => {
  it("refuses an export with credential-looking keys, whole, whatever the casing or depth", () => {
    for (const key of ["api_key", "apiKey", "accessToken", "client_secret", "password", "Authorization", "cookie", "private-key"]) {
      const error = refused({ format: GROK_EXPORT_FORMAT, bots: [{ name: "x", skills: [{ name: "s", instructions: "i", [key]: "v" }] }] });
      expect(error.code, key).toBe("credentials");
      expect(error.keys[0], key).toContain(key);
    }
    expect(refused(`Here:\n\`\`\`json\n${JSON.stringify({ format: GROK_EXPORT_FORMAT, api_key: "x", bots: [{ name: "x" }] })}\n\`\`\``).code).toBe("credentials");
    expect(refused({ format: GROK_EXPORT_FORMAT, bots: [{ name: "x", apps: [{ name: "a", api_key: "v" }] }] }).code).toBe("credentials");
  });

  it("redacts token-shaped text everywhere, including what is listed to rebuild", () => {
    const [bot] = parseGrokExport(FILE);
    expect(grokRedactions(bot!)).toBe(2);
    expect(grokRedactions(mergeGrokBots([...parseGrokExport(FILE), ...parseGrokExport(FILE)])[0]!)).toBe(2);
    const moved = grokMovePlan(bot!, { timeZone: "UTC" });
    const shown = JSON.stringify(moved);
    expect(shown).not.toContain(TOKEN);
    expect(moved.rebuild[0]!.instruction).toContain("Reproduce the ticket");
    expect(moved.memories.join()).toContain("is old");
  });

  it("strips an app's values and lists their names, and keeps its address only without a key", () => {
    const moved = plan({
      name: "M",
      apps: [
        { name: "Linear", mcp_url: "https://mcp.linear.app/mcp?api_key=abc&team=x", headers: { Authorization: "Bearer real-secret-value", "X-Org": "acme" }, env: { LINEAR_TOKEN: "real-env-secret" } },
        { name: "Userinfo", mcp_url: "https://me:pw@mcp.example.com/mcp" },
        { name: "Zapier", mcp_url: "https://mcp.zapier.com/api/mcp/s/a1b2c3d4e5f6g7h8i9j0k1l2m3n4/mcp" },
        { name: "Local", mcp_url: "http://localhost:3000/mcp" },
        { name: "Plain", mcp_url: "http://mcp.example.com/mcp" },
        { name: "Bearer", mcp_url: `https://mcp.example.com/mcp/${TOKEN}` },
        { name: "Stream", mcp_url: "https://mcp.example.com/sse" },
      ],
    });
    const { connections } = moved.document.package;
    const linear = connections!.find((connection) => connection.label === "Linear")!;
    expect(linear.mcp).toEqual({ transport: "http", url: "https://mcp.linear.app/mcp?team=x", valueNames: ["Authorization", "X-Org"] });
    expect(moved.servers.find((server) => server.name === "Linear")!.values).toEqual(["Authorization", "X-Org", "LINEAR_TOKEN", "api_key"]);
    expect(connections!.find((connection) => connection.label === "Userinfo")!.mcp.url).toBe("https://mcp.example.com/mcp");
    expect(connections!.find((connection) => connection.label === "Stream")!.mcp.transport).toBe("sse");
    const notes = moved.notes.map((note) => ("name" in note ? `${note.kind}:${note.name}` : note.kind));
    expect(notes).toEqual(expect.arrayContaining(["serverKeyInAddress:Zapier", "serverKeyInAddress:Bearer", "serverInsecure:Local", "serverInsecure:Plain"]));
    expect(JSON.stringify(moved)).not.toMatch(/real-secret-value|real-env-secret|a1b2c3d4e5f6|abc&/);
  });

  it("gains nothing by being imported: the file's own claims do not survive", () => {
    const document = plan().document;
    expect(document.package.publisher).toBeUndefined();
    expect(document.package.agents[0]!.approval).toBeUndefined();
    expect(document.package.routines!.every((routine) => routine.enabledAfterInstall === false)).toBe(true);
    expect(() => parsePackageDocument(document, { trust: "file" })).not.toThrow();
  });
});

describe("what comes over", () => {
  it("maps a Bot to one bot: role, skills by reference, deduplicated memory", () => {
    const moved = plan();
    const agent = moved.document.package.agents[0]!;
    expect(agent).toMatchObject({ name: "Account Health", title: "Customer success", soul: BOT.instructions, skills: ["weekly-account-health"] });
    expect(moved.skills).toEqual(["Weekly account health"]);
    expect(moved.notes).toContainEqual({ kind: "skillEmpty", name: "Empty one" });
    const memory = agent.seed!.memory["MEMORY.md"]!;
    expect(memory.match(/three weeks without a login/gi)).toHaveLength(1);
    expect(memory).toContain("## About the person\n\n- Works in America/New_York");
    expect(moved.memories).toHaveLength(3);
  });

  it("creates scheduled routines paused, keeping schedule, zone and skills", () => {
    const moved = plan();
    const [watch, monday] = moved.document.package.routines!;
    expect(watch).toMatchObject({ name: "Morning watch list", enabledAfterInstall: false, schedule: { type: "cron", expression: "0 8 * * 1-5", timeZone: "America/New_York" } });
    expect(watch!.prompt).toContain("Use these skills: weekly-account-health.");
    expect(monday).toMatchObject({ name: "Monday check", enabledAfterInstall: false, schedule: { timeZone: "America/Los_Angeles" } });
    expect(moved.routines.map((routine) => routine.pausedThere)).toEqual([false, true]);
  });

  it("creates no routine for an event: a webhook becomes a paused automation to make, the rest are listed with their text", () => {
    const moved = plan();
    expect(moved.document.package.routines!.map((routine) => routine.name)).toEqual(["Morning watch list", "Monday check"]);
    expect(moved.webhooks).toEqual([{ name: "Order hook", prompt: "File the order.", details: "from the shop", pausedThere: false }]);
    expect(moved.rebuild).toEqual([expect.objectContaining({ name: "Escalations", trigger: "slack", reason: "event", details: "#customer-escalations, phrase 'needs repro'" })]);
    for (const trigger of ["github", "linear", "sentry", "pagerduty", "email", "other"]) {
      const list = plan({ name: "E", routines: [{ name: "r", instruction: "i", trigger }] });
      expect(list.document.package.routines, trigger).toBeUndefined();
      expect(list.webhooks, trigger).toEqual([]);
      expect(list.rebuild[0], trigger).toMatchObject({ reason: "event", trigger, instruction: "i" });
    }
  });

  it("says when a schedule can't be read or a zone isn't known, instead of guessing", () => {
    const moved = plan({ name: "T", routines: [
      { name: "Bad zone", instruction: "i", trigger: "schedule", schedule_cron: "0 9 * * *", timezone: "Pacific/Nowhere" },
      { name: "Words", instruction: "i", trigger: "schedule", schedule_text: "weekdays at 9am" },
      { name: "Vague", instruction: "i", trigger: "schedule", schedule_text: "now and then" },
      { name: "Nothing", trigger: "schedule", schedule_cron: "0 9 * * *" },
    ] });
    const routines = moved.document.package.routines!;
    expect(routines[0]).toMatchObject({ name: "Bad zone", schedule: { timeZone: "Europe/Berlin" } });
    expect(routines[1]).toMatchObject({ name: "Words", schedule: { type: "daily", time: "09:00" } });
    expect(moved.notes).toEqual(expect.arrayContaining([{ kind: "routineMovedZone", name: "Bad zone" }, { kind: "routineEmpty", name: "Nothing" }]));
    expect(moved.rebuild[0]).toMatchObject({ name: "Vague", reason: "schedule" });
  });

  it("an empty Bot and a very busy one both become valid packages", () => {
    const empty = plan({ name: "Empty", instructions: "Just chat." });
    expect(empty).toMatchObject({ skills: [], routines: [], memories: [], servers: [], apps: [], rebuild: [], webhooks: [] });
    const busy = plan({
      name: "Busy",
      skills: Array.from({ length: 35 }, (_, i) => ({ name: `Skill ${i}`, instructions: `Do ${i}.` })),
      routines: Array.from({ length: 60 }, (_, i) => ({ name: `Routine ${i}`, instruction: `Do ${i}.`, schedule_cron: "0 9 * * *" })),
      apps: Array.from({ length: 25 }, (_, i) => ({ name: `Server ${i}`, mcp_url: `https://s${i}.example.com/mcp` })),
    });
    expect(busy.skills).toHaveLength(30);
    expect(busy.routines).toHaveLength(50);
    expect(busy.servers).toHaveLength(20);
    expect(busy.rebuild.filter((routine) => routine.reason === "limit")).toHaveLength(10);
    expect(busy.notes.filter((note) => note.kind === "skillLimit")).toHaveLength(5);
    expect(busy.notes.filter((note) => note.kind === "serverLimit")).toHaveLength(5);
  });

  it("two Bots with the same skill, routine and app names stay separate packages", () => {
    const shared = { skills: [{ name: "Same", instructions: "x" }], routines: [{ name: "Same", instruction: "x", schedule_cron: "0 9 * * *" }], apps: [{ name: "Linear", mcp_url: "https://mcp.linear.app/mcp" }] };
    const [one, two] = [plan({ name: "One", ...shared }), plan({ name: "Two", ...shared })];
    expect(one.document.package.id).not.toBe(two.document.package.id);
    expect(one.document.package.team!.name).toBe("One");
    expect(two.document.package.team!.name).toBe("Two");
  });

  it("names routines a Bot announced that its export left out", () => {
    const bot = parseGrokExport(FILE)[0]!;
    expect(routinesLeftOut(bot, ["Morning Watch List", "routine-healthcheck"])).toEqual(["routine-healthcheck"]);
  });

  it("merges the same Bot across files by name, whatever the case", () => {
    const bot = (name: string, memories: string[]): GrokBot => ({ name, title: "", description: "", instructions: "", memories, userFacts: [], skills: [], routines: [], apps: [] });
    expect(mergeGrokBots([bot("Desk", ["a"]), bot("desk", ["a", "b"]), bot("Other", [])]).map((item) => [item.name, item.memories])).toEqual([["Desk", ["a", "b"]], ["Other", []]]);
  });
});
