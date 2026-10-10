import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("applies independent creation templates through the real isolated HTTP routes", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const original = (await api("GET", "/api/bots")).bots;
    const skill = { name: "fixture-skill", description: "Synthetic", source: "fixture", enabled: false,
      warnings: [], text: "---\nname: fixture-skill\ndescription: Synthetic\n---\nFixture instructions." };
    const defaults = {
      profile: { name: "", title: "Template", description: "Description", soul: "Standing instructions",
        notifications: false, computer: "off", approvalMode: "ask", mascotExpression: null },
      memory: { "MEMORY.md": "Synthetic default memory" }, skills: [skill],
      routines: [{ name: "Review", prompt: "Review status", enabled: false,
        schedule: { type: "daily", time: "09:00", weekdays: [1] } }],
    };
    await api("PATCH", "/api/config", { newBotDefaults: defaults });
    expect((await api("GET", "/api/bots")).bots).toEqual(original);
    expect((await api("GET", "/api/bot-defaults")).defaults).toEqual(defaults);
    const first = (await api("POST", "/api/bots", {}, 201)).bot;
    const second = (await api("POST", "/api/bots", { name: "Second" }, 201)).bot;
    expect(first.name.length).toBeGreaterThan(0);
    for (const bot of [first, second]) {
      expect(bot).toMatchObject({ title: "Template", soul: "Standing instructions", notifications: false, computer: "off" });
      const memory = await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`);
      expect(JSON.stringify(memory)).toContain("Synthetic default memory");
      expect((await api("GET", `/api/bots/${bot.id}/skills`)).skills).toHaveLength(1);
    }
    const routines = (await api("GET", "/api/routines")).routines;
    expect(routines.filter((routine: any) => [first.id, second.id].includes(routine.botId))).toHaveLength(2);
    expect(routines.every((routine: any) => !routine.enabled)).toBe(true);
    const explicit = (await api("POST", "/api/bots", { title: "", settings: { description: "", computer: null, notifications: true } }, 201)).bot;
    expect(explicit).toMatchObject({ title: "", description: "", notifications: true });
    expect(explicit.computer ?? null).toBe(null);
    const optOut = (await api("POST", "/api/bots", { useDefaults: false, name: "Resolved draft" }, 201)).bot;
    expect(optOut.title).toBe("");
    expect((await api("GET", `/api/bots/${optOut.id}/skills`)).skills).toHaveLength(0);
    const restricted = (await api("POST", "/api/bots", { useDefaults: false, name: "Restricted draft", visibility: "admins" }, 201)).bot;
    expect(restricted.visibility).toBe("admins");
    const beforeInvalid = (await api("GET", "/api/bots")).bots.length;
    await api("POST", "/api/bots", { name: "Invalid audience", visibility: { people: 42 } }, 400);
    expect((await api("GET", "/api/bots")).bots.length).toBe(beforeInvalid);
    await api("POST", "/api/bots", { useDefaults: "false" }, 400);
    await api("POST", "/api/bots", { name: 42 }, 400);
    await api("POST", "/api/bots", { settings: null }, 400);
    await api("POST", "/api/bots", { settings: { approvalMode: "unknown" } }, 400);
    const blank = (await api("POST", "/api/bots", { name: "", section: null }, 201)).bot;
    expect(blank.name).not.toBe("");
    expect(blank.section ?? "").toBe("");
    for (const body of [null, [], {}, { source: 42 }, { source: "x".repeat(2001) }]) {
      await api("POST", "/api/bot-defaults/skills/preview", body, 400);
      await api("POST", `/api/bots/${first.id}/skill-template`, body, 400);
    }
    for (const body of [null, [], {}, { profile: {}, prompt: 42 }]) {
      await api("POST", "/api/bot-defaults/avatar", body, 400);
    }
    await api("PATCH", "/api/config", { browserProfiles: [{ id: "fixture-profile", name: "Fixture profile" }] });
    await api("PATCH", "/api/config", { newBotDefaults: { profile: { browserProfile: "fixture-profile" } } });
    await api("PATCH", "/api/config", { browserProfiles: [] });
    expect((await api("GET", "/api/bot-defaults")).defaults.profile.browserProfile).toBeUndefined();
    expect((await api("POST", "/api/bots", { name: "After profile removal" }, 201)).bot.browserProfile).toBeUndefined();
    for (const mode of ["full", "custom"]) {
      await api("PATCH", "/api/config", { newBotDefaults: { profile: { approvalMode: mode } } });
      const count = (await api("GET", "/api/bots")).bots.length;
      await api("POST", "/api/bots", {}, 403);
      expect((await api("GET", "/api/bots")).bots).toHaveLength(count);
      expect((await api("POST", "/api/bots", { settings: { approvalMode: "ask" } }, 201)).bot.approvalMode).toBe("ask");
    }
  } finally { await fixture.close(); }
}, 90_000);
