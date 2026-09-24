import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { NEWER_PACKAGE_MESSAGE, parsePackageDocument } from "../shared/package-format.ts";
import { NO_BOTS_MESSAGE } from "./package-import.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// The recipe in docs/verification/team-sharing.md: a disposable fake-engine
// server, a team built through the public API, Share team (dry run and save),
// renames, then the file imported back as an untrusted file.
it("shares one team whole (minus chat history) and imports it back as new, inert copies", async () => {
  const fixture = await launchVerificationServer();
  console.log(JSON.stringify({ fixture: fixture.info }));
  const url = fixture.info.url;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const result = await call(method, path, body);
    if (result.status >= 300) throw new Error(`${method} ${path} → ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
  try {
    const lead = (await ok("POST", "/api/bots", { name: "Morgan", title: "Sales lead", description: "Owns the pipeline.", color: "purple", section: "Sales desk" })).bot;
    const scout = (await ok("POST", "/api/bots", { name: "Scout", title: "Researcher", color: "cyan", section: "Sales desk" })).bot;
    const outsider = (await ok("POST", "/api/bots", { name: "Elsewhere", section: "Support" })).bot;
    await ok("PATCH", `/api/bots/${lead.id}`, { chiefOfStaff: true, soul: "Coordinate. The portal password=SalesDesk-Portal-2026 stays private.\n" });
    await ok("PUT", `/api/section-context?section=${encodeURIComponent("Sales desk")}`, { text: "Quote list prices only." });
    await ok("POST", `/api/bots/${scout.id}/skill-template`, {
      name: "research-brief", description: "Write a prospect brief.", source: "fixture",
      text: "---\nname: research-brief\ndescription: Write a prospect brief.\n---\n\n# Brief\n", enabled: true,
    });
    await ok("POST", "/api/mcp/servers", { name: "crm", type: "http", url: "https://mcp.example.com/crm", headers: { Authorization: "Bearer fixture-secret-value" }, enabled: true });
    await ok("POST", "/api/mcp/servers", { name: "local-tool", command: "npx", args: ["fixture"], enabled: true });
    await ok("PATCH", `/api/bots/${lead.id}`, { mcpServers: ["crm", "local-tool"] });
    await ok("PUT", `/api/bots/${lead.id}/memory/file`, { path: "MEMORY.md", text: "- Prefers short summaries.\n" });
    await ok("PUT", `/api/bots/${lead.id}/memory/file`, { path: "memory/pricing.md", text: "List price 49.\n" });
    const room = (await ok("POST", "/api/groups", { name: "Deal desk", memberIds: [lead.id, scout.id, outsider.id], section: "Sales desk" })).group;
    await ok("PATCH", `/api/groups/${room.id}/setup`, { action: "complete", cwd: null, bulletin: "Cite sources.", defaultResponder: { kind: "member", botId: lead.id } });
    await ok("POST", "/api/routines", { name: "Daily digest", prompt: "Summarize new leads.", botId: scout.id, enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30 });
    await ok("POST", "/api/routines", { name: "Weekly review", prompt: "Review the pipeline.", botId: lead.id, target: "room-goal", groupId: room.id, enabled: false,
      schedule: { type: "cron", expression: "0 10 * * 1", timeZone: "UTC" }, durationMinutes: 60 });

    const body = { format: "package", version: 2, team: "Sales desk", includeMemory: true, avatars: { [lead.id]: `data:image/png;base64,${PNG}` } };
    const published = join(fixture.info.dataDir, "published-teams.json");
    const preview = await ok("POST", "/api/teams/export", { ...body, dryRun: true });
    expect(existsSync(published)).toBe(false);
    expect(preview.summary.counts).toEqual({ bots: 2, skills: 1, presets: 0, rooms: 1, routines: 2, connections: 1, playbooks: 0 });
    expect(preview.choices.skills).toEqual(["research-brief"]);
    const saved = await ok("POST", "/api/teams/export", body);
    expect(saved.filename).toBe("sales-desk-1.0.0.openmaus.json");
    expect(saved.redacted).toEqual(["agents[morgan].soul"]);
    expect(saved.skipped).toEqual([{ part: "connections[local-tool]", reason: "stdio_server" }]);
    const text = JSON.stringify(saved.document);
    expect(text).not.toMatch(/SalesDesk-Portal-2026|fixture-secret-value|Elsewhere|modelSelection|threadId/);
    expect(saved.document.package.agents.find((agent: { key: string }) => agent.key === "morgan").seed.memory).toEqual({ "MEMORY.md": "- Prefers short summaries.\n", "memory/pricing.md": "List price 49.\n" });
    expect(existsSync(published)).toBe(true);

    // Renaming the team and a bot keeps the package id and every key; the
    // next save suggests the next patch release.
    await ok("PATCH", `/api/sidebar-sections?section=${encodeURIComponent("Sales desk")}`, { name: "Revenue desk" });
    await ok("PATCH", `/api/bots/${scout.id}`, { name: "Scout Two" });
    const again = await ok("POST", "/api/teams/export", { ...body, team: "Revenue desk" });
    expect(again.document.package.id).toBe("sales-desk");
    expect(again.document.package.release).toBe("1.0.1");
    expect(again.document.package.agents.map((agent: { key: string }) => agent.key)).toEqual(saved.document.package.agents.map((agent: { key: string }) => agent.key));
    expect(again.document.package.rooms[0].key).toBe(saved.document.package.rooms[0].key);

    // Import the saved file. The body claims trust and a publisher; both are
    // ignored: this is a file.
    const beforeServers = (await ok("GET", "/api/mcp/servers")).servers.map((server: { name: string }) => server.name);
    const imported = await call("POST", "/api/teams/import?trust=org", {
      ...saved.document, trust: "org", org: { installId: "x" },
      package: { ...saved.document.package, publisher: { organization: "acme", name: "Acme" } },
    });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ section: "Sales desk", brief: true, notes: 2, offeredSkills: [], skipped: [] });
    expect(imported.body.connections).toEqual([{ key: "crm", name: "crm-2", label: "crm" }]);
    const copies = imported.body.bots as Array<{ id: string; name: string; installedPackage: Record<string, unknown>; approvalMode?: string; avatarUrl: string | null; mcpServers?: string[]; chiefOfStaff?: boolean }>;
    const copyLead = copies.find((bot) => bot.name === "Morgan 2")!;
    expect(copyLead).toMatchObject({ chiefOfStaff: true, mcpServers: ["crm-2"], installedPackage: { id: "sales-desk", source: "file", agentKey: "morgan" } });
    expect(copyLead.installedPackage).not.toHaveProperty("publisher");
    expect(copyLead.avatarUrl).toMatch(/^\/api\/attachments\//);
    for (const bot of copies) {
      const skills = (await ok("GET", `/api/bots/${bot.id}/skills`)).skills as Array<{ enabled: boolean }>;
      expect(skills.every((skill) => !skill.enabled)).toBe(true);
    }
    expect(imported.body.routines.every((routine: { enabled: boolean }) => !routine.enabled)).toBe(true);
    expect(imported.body.routines.map((routine: { target: string }) => routine.target).sort()).toEqual(["bot", "room-goal"]);
    const servers = (await ok("GET", "/api/mcp/servers")).servers as Array<{ name: string; enabled: boolean; headerKeys?: string[] }>;
    expect(servers.map((server) => server.name).sort()).toEqual([...beforeServers, "crm-2"].sort());
    expect(servers.find((server) => server.name === "crm-2")).toMatchObject({ enabled: false, headerKeys: ["Authorization"] });
    const config = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(config.mcpServers["crm-2"].headers).toEqual({ Authorization: "" });
    expect((await ok("GET", `/api/section-context?section=${encodeURIComponent("Sales desk")}`)).text).toBe("Quote list prices only.");
    expect((await ok("GET", `/api/bots/${copyLead.id}/memory/file?path=${encodeURIComponent("memory/pricing.md")}`)).text).toBe("List price 49.\n");
    expect(imported.body.groups[0]).toMatchObject({ name: "Deal desk", bulletin: "Cite sources.", defaultResponder: { kind: "member", botId: copyLead.id } });

    // Other files: a library-only package points at the shelf; a newer file
    // asks for an update; neither creates anything.
    const before = await ok("GET", "/api/bots");
    const library = await call("POST", "/api/teams/import", JSON.parse(readFileSync(join(FIXTURES, "library-only.v2.json"), "utf8")));
    expect(library).toEqual({ status: 400, body: { error: NO_BOTS_MESSAGE, code: "no_bots" } });
    const newer = await call("POST", "/api/teams/import", JSON.parse(readFileSync(join(FIXTURES, "newer.v3.json"), "utf8")));
    expect(newer).toEqual({ status: 400, body: { error: NEWER_PACKAGE_MESSAGE } });
    expect(await ok("GET", "/api/bots")).toEqual(before);
    // The saved document is exactly what every reader accepts.
    expect(() => parsePackageDocument(saved.document)).not.toThrow();
  } finally {
    await fixture.close();
  }
}, 120_000);
