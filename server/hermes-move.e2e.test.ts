import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { grokMovePlan, parseGrokExport } from "../shared/grok-import.ts";

it("imports a Hermes profile through the real package API with memory, skills and paused routines", async () => {
  const fixture = await launchVerificationServer();
  console.log(JSON.stringify({ fixture: fixture.info }));
  const url = fixture.info.url;
  const exported = JSON.stringify({ format: "hermes-bot-export", version: 1, bots: [{
    name: "Hermes fixture", instructions: "Prepare a short daily brief.",
    memories: ["Project code is Orchid"], user_facts: ["Prefers short replies"],
    skills: [{ name: "Daily brief", description: "Write the brief", instructions: "Summarize the day's work." }],
    routines: [{ name: "Morning", instruction: "Write the brief.", schedule_cron: "0 9 * * 1-5", timezone: "Asia/Kolkata" }],
    apps: [{ name: "Linear", mcp_url: "https://mcp.linear.app/mcp" }],
  }] });
  try {
    const plan = grokMovePlan(parseGrokExport(exported)[0]!, { source: "hermes" });
    const imported = await request("/api/teams/import?mode=add", {
      method: "POST", body: JSON.stringify(plan.document),
    }, url);
    const bot = imported.bots[0];
    expect(bot).toMatchObject({ name: "Hermes fixture", soul: "Prepare a short daily brief." });
    expect(bot.installedPackage.id).toBe(plan.packageId);
    const memory = await request(`/api/bots/${bot.id}/memory`, {}, url);
    expect(memory.text).toContain("# Notes from Hermes");
    expect(memory.text).toContain("Project code is Orchid");
    expect(memory.text).toContain("Prefers short replies");
    const routines = await request("/api/routines", {}, url);
    expect(routines.routines).toContainEqual(expect.objectContaining({
      botId: bot.id, enabled: false, schedule: { type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Kolkata" },
    }));
    const skills = await request(`/api/bots/${bot.id}/skills`, {}, url);
    expect(skills.skills).toContainEqual(expect.objectContaining({ name: "daily-brief", enabled: false }));
    await request(`/api/bots/${bot.id}/skills/daily-brief`, {
      method: "PATCH", body: JSON.stringify({ enabled: true }),
    }, url);
    expect((await request(`/api/bots/${bot.id}/skills`, {}, url)).skills)
      .toContainEqual(expect.objectContaining({ name: "daily-brief", enabled: true }));
    const servers = await request("/api/mcp/servers", {}, url);
    expect(servers.servers).toContainEqual(expect.objectContaining({ name: "linear", enabled: false }));
  } finally {
    await fixture.close();
  }
});
