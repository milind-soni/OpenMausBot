import { describe, expect, it } from "vitest";
import { HERMES_EXPORT_PROMPT, hermesMovePlan, parseHermesExport } from "./hermes-import.ts";
import { BotImportError } from "./bot-import.ts";
import { GROK_EXPORT_FORMAT, grokMovePlan, parseGrokExport } from "./grok-import.ts";
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
    { name: "Linear", mcp_url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer real-secret-value" } },
    { name: "Gmail", mcp_url: "" },
  ],
};
const plan = (bot: unknown = BOT) => grokMovePlan(parseGrokExport(JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [bot] }))[0]!, { timeZone: "Europe/Berlin" });


describe("Hermes profile export", () => {
  it("asks for the current profile's setup without reading logins or changing the source", () => {
    expect(HERMES_EXPORT_PROMPT).toContain('"format": "hermes-bot-export"');
    expect(HERMES_EXPORT_PROMPT).toContain("hermes-bot-export-<your name>.json");
    for (const path of ["SOUL.md", "memories/MEMORY.md", "memories/USER.md", "skills/**/SKILL.md", "HERMES_HOME"]) {
      expect(HERMES_EXPORT_PROMPT).toContain(path);
    }
    expect(HERMES_EXPORT_PROMPT).toContain("Never read or include .env, auth.json");
    expect(HERMES_EXPORT_PROMPT).toContain("Do not change, pause or delete anything");
  });

  it("keeps Hermes provenance and identity separate from an identical Grok bot", () => {
    const bots = parseHermesExport(`Here is the export:\n\`\`\`json\n${JSON.stringify({ format: "hermes-bot-export", version: 1, bots: [BOT] })}\n\`\`\``);
    const hermes = hermesMovePlan(bots[0]!, { timeZone: "Europe/Berlin" });
    expect(hermes.packageId).not.toBe(plan().packageId);
    expect(hermes.document.package.author.name).toBe("Hermes");
    const seed = hermes.document.package.agents[0]!.seed?.memory;
    expect(seed?.["MEMORY.md"]).toContain("# Notes from Hermes");
    expect(seed?.["memory/hermes-event-routines.md"]).toContain("Hermes routines");
    expect(JSON.stringify(hermes.document)).not.toContain("Grok Bot");
    expect(hermes.routines).toBe(2);
    expect(hermes.notes).toBe(2);
    expect(hermes.document.package.routines?.every((routine) => routine.enabledAfterInstall === false)).toBe(true);
    expect(JSON.stringify(hermes.document)).not.toContain(TOKEN);
  });

  it("refuses credentials in a Hermes export before making a plan", () => {
    expect(() => parseHermesExport(JSON.stringify({ format: "hermes-bot-export", bots: [{ ...BOT, api_key: "private" }] })))
      .toThrow(BotImportError);
  });
});

