import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { checkProfileFiles } from "../../shared/profile-format.ts";
import type { ProfileChoice, ProfilePlanLine } from "../../shared/profile-plan.ts";
import type { ProfileSource } from "../../shared/wire.ts";
import { applyProfilePlan } from "./apply.ts";
import { profileFilesHash } from "./load.ts";
import { botSecretSlots, changedHereFields, decide, planProfiles, type AppView } from "./plan.ts";
import { withDepartmentRenamed, type ProfilesState } from "./state.ts";

type Rec = Record<string, any>;
const ACME = join(import.meta.dirname, "..", "testing", "fixtures", "profiles", "acme");

function filesOf(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { recursive: true }).map(String).filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => ({ path: relative(dir, join(dir, path)).split("\\").join("/"), text: readFileSync(join(dir, path), "utf8").replace(/\r\n/g, "\n") }));
}
const ACME_FILES = filesOf(ACME);

/** The acme folder with some files' text replaced (`null` deletes the file). */
function folder(edits: Record<string, string | null | ((text: string) => string)> = {}) {
  const files = ACME_FILES.flatMap((file) => {
    const edit = edits[file.path];
    if (edit === null) return [];
    return [{ path: file.path, text: typeof edit === "function" ? edit(file.text) : edit ?? file.text }];
  });
  for (const [path, text] of Object.entries(edits)) if (typeof text === "string" && !files.some((file) => file.path === path)) files.push({ path, text });
  return { ...checkProfileFiles(files), root: "/profiles/acme", contentHash: profileFilesHash(files) };
}

/** `profiles` with a problem at `file`, as the loader reports a link or an unreadable path there. */
const withProblem = (profiles: ReturnType<typeof folder>, file: string) =>
  ({ ...profiles, problems: [...profiles.problems, { file, message: "is a link; profiles never follow links, so put the file itself in the folder" }] });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** An app in memory, answering the routes apply calls the way the server does. `thisComputer`: the desktop app with its
 * computer connected, where a new bot not on Auto works on this computer and Auto there needs the person's confirmation. */
function fakeApp(seed: { bots?: Rec[]; sections?: string[]; mcpServers?: string[]; models?: string[]; thisComputer?: boolean } = {}) {
  const app = {
    bots: (seed.bots ?? []) as Rec[],
    sections: seed.sections ?? [],
    briefs: {} as Record<string, string>,
    skills: {} as Record<string, Record<string, { text: string; enabled: boolean }>>,
    state: { version: 1, areas: {} } as ProfilesState,
    refuse: null as null | ((method: string, path: string, body: Rec) => string | null),
    calls: [] as string[],
  };
  let ids = 0;
  const port = {
    async call(method: string, path: string, body: Rec = {}) {
      app.calls.push(`${method} ${path}`);
      const refused = app.refuse?.(method, path, body);
      if (refused) return { status: 403, body: { error: refused } };
      const url = new URL(path, "http://app");
      const m = url.pathname.split("/").slice(1);
      if (url.pathname === "/api/sidebar-sections" && method === "POST") { app.sections.push(body.name); return { status: 200, body: {} }; }
      if (url.pathname === "/api/sidebar-sections" && method === "PATCH") {
        const from = url.searchParams.get("section")!;
        app.sections = app.sections.map((section) => (section === from ? body.name : section));
        for (const bot of app.bots) if (bot.section === from) bot.section = body.name;
        app.briefs[body.name] = app.briefs[from] ?? "";
        app.state = withDepartmentRenamed(app.state, from, body.name);
        return { status: 200, body: {} };
      }
      if (url.pathname === "/api/section-context") { app.briefs[url.searchParams.get("section")!] = body.text; return { status: 200, body: {} }; }
      if (url.pathname === "/api/bots" && method === "POST") {
        const bot: Rec = { id: `bot-${++ids}`, name: body.name, title: body.title ?? "", description: body.description ?? "", section: body.section,
          modelSelection: body.modelSelection ?? { instanceId: "claude", model: "claude-sonnet-5-5" }, ...(body.settings?.approvalMode ? { approvalMode: body.settings.approvalMode } : {}),
          ...(seed.thisComputer && body.settings?.approvalMode !== "auto" ? { computer: "local" } : {}) };
        app.bots.push(bot);
        return { status: 200, body: { bot } };
      }
      const bot = app.bots.find((candidate) => candidate.id === m[2]);
      if (!bot) return { status: 404, body: { error: "no such bot" } };
      if (m.length === 3 && method === "PATCH") {
        if (body.approvalMode === "auto" && bot.computer === "local" && body.acknowledgeLocalAuto !== true) {
          return { status: 400, body: { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" } };
        }
        const { applyToAllThreads: _all, requireAvailableModel: _require, ...fields } = body;
        Object.assign(bot, fields);
        return { status: 200, body: { bot } };
      }
      if (m.length === 3 && method === "DELETE") { app.bots = app.bots.filter((candidate) => candidate !== bot); return { status: 200, body: {} }; }
      const skills = app.skills[bot.id] ??= {};
      if (m[3] === "skill-template") { skills[body.name] = { text: body.text, enabled: body.enabled }; return { status: 201, body: {} }; }
      if (m[3] === "skills" && method === "DELETE") { delete skills[m[4]!]; return { status: 200, body: {} }; }
      if (m[3] === "skills" && method === "PATCH") { skills[m[4]!]!.enabled = body.enabled; return { status: 200, body: {} }; }
      return { status: 404, body: { error: `no route ${method} ${path}` } };
    },
    stamp(botId: string, source: ProfileSource) { app.bots.find((bot) => bot.id === botId)!.profileSource = source; },
  };
  const view = (): AppView => ({
    bots: app.bots, sections: app.sections, briefs: app.briefs,
    skills: Object.fromEntries(Object.entries(app.skills).map(([id, skills]) => [id, Object.entries(skills).map(([name, skill]) => ({ name, enabled: skill.enabled, sha256: sha(skill.text) }))])),
    instances: [{ instanceId: "claude", models: seed.models ?? ["claude-sonnet-5-5", "claude-haiku-5"] }],
    mcpServers: seed.mcpServers ?? ["notion"],
  });
  const plan = (profiles = folder(), options: { choices?: Record<string, ProfileChoice>; prune?: boolean } = {}) =>
    planProfiles({ folder: profiles, app: view(), state: app.state, ...options });
  const apply = async (profiles = folder(), options: { choices?: Record<string, ProfileChoice>; prune?: boolean; giveAccess?: boolean } = {}) => {
    const planned = plan(profiles, options);
    const outcome = await applyProfilePlan(planned, app.state.areas, port, { giveAccess: options.giveAccess ?? true, now: 1, folderName: "acme" });
    app.state = { ...app.state, areas: outcome.areas };
    return { planned, outcome };
  };
  const bot = (id: string) => app.bots.find((candidate) => `${candidate.profileSource?.area}/${candidate.profileSource?.key}` === id)!;
  return { app, port, plan, apply, bot };
}

const kinds = (lines: readonly ProfilePlanLine[], kind: ProfilePlanLine["kind"]) => lines.filter((line) => line.kind === kind).map((line) => line.text);
const withField = (field: string, value: string) => (text: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (at >= 0) lines[at] = `${field}: ${value}`;
  else lines.splice(lines.indexOf("---", 1), 0, `${field}: ${value}`);
  return lines.join("\n");
};

describe("decide", () => {
  it("takes the file when only the file changed, keeps the app when only the app changed, and calls both a conflict", () => {
    expect(decide("a", "a", "a")).toBe("same");
    expect(decide("a", "b", "a")).toBe("take");
    expect(decide("a", "a", "b")).toBe("here");
    expect(decide("a", "b", "c")).toBe("conflict");
    expect(decide("a", "b", "b")).toBe("same");
    expect(decide(undefined, "b", "c")).toBe("take");
  });
});

describe("planProfiles", () => {
  it("adds every area and bot of a new folder, and a second plan has no changes", async () => {
    const { app, plan, apply, bot } = fakeApp();
    const first = plan().plan;
    expect(kinds(first.lines, "add")).toEqual([
      "Adds area BI", "Area BI: brief set", "Adds area Sales", "Area Sales: brief set",
      "Adds Analista BI to area BI (Data analyst · Chief of BI · claude/claude-sonnet-5-5 · Auto)",
      "Adds Reporter to area BI (Weekly report writer · claude/claude-sonnet-5-5 · Ask)",
      "Adds Closer to area Sales (Sales follow-up · Accept edits)",
    ]);
    expect(first.noChanges).toBe(false);
    await apply();
    expect(app.sections).toEqual(["BI", "Sales"]);
    expect(app.briefs.BI).toBe("Acme sells garden tools in Chile. Answer in Spanish unless asked otherwise.\n\nThe BI area turns sales data into weekly decisions. Numbers come from tools, never from memory.");
    expect(bot("bi/analyst")).toMatchObject({ name: "Analista BI", section: "BI", approvalMode: "auto", chiefOfStaff: true, eduCrew: true, mcpServers: ["notion"],
      toolScope: { allow: ["native:*", "mcp:edu:*", "mcp:notion:*"] }, modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      profileSource: { area: "bi", key: "analyst", file: "areas/bi/bots/analyst.md" } });
    expect(bot("bi/reporter")).toMatchObject({ toolsOff: ["images"], approvalMode: "ask" });
    expect(app.skills[bot("bi/analyst").id]).toEqual({ "weekly-report": { text: expect.stringContaining("# Weekly report"), enabled: true } });
    const second = plan().plan;
    expect(second.lines.filter((line) => !["later", "note"].includes(line.kind))).toEqual([]);
    expect(second.noChanges).toBe(true);
  });

  it("matches bots on their area and key: a new name in the file renames the bot, a new key adds a bot", async () => {
    const { app, apply, bot } = fakeApp();
    await apply();
    const before = app.bots.length;
    const renamed = folder({
      "areas/bi/bots/reporter.md": withField("name", "Informes"),
      "areas/bi/bots/writer.md": "---\nedubot: 1\nkind: bot\nkey: writer\nname: Writer\n---\nYou write.\n",
    });
    const { planned } = await apply(renamed);
    expect(kinds(planned.plan.lines, "change")).toEqual(['Informes: name "Reporter" → "Informes"']);
    expect(kinds(planned.plan.lines, "add")).toEqual(["Adds Writer to area BI (claude/claude-sonnet-5-5 · Ask)"]);
    expect(app.bots.length).toBe(before + 1);
    expect(bot("bi/reporter").name).toBe("Informes");
  });

  it("keeps a bot no longer in the files and says so; prune deletes it", async () => {
    const { app, plan, apply } = fakeApp();
    await apply();
    const without = folder({ "areas/sales/bots/closer.md": null });
    expect(kinds(plan(without).plan.lines, "gone")).toEqual(["Closer is no longer in your profiles; it stays in this app as it is"]);
    await apply(without);
    expect(app.bots.some((candidate) => candidate.name === "Closer")).toBe(true);
    const pruned = await apply(without, { prune: true });
    expect(kinds(pruned.planned.plan.lines, "remove")).toEqual(["Deletes Closer, which is no longer in your profiles"]);
    expect(app.bots.some((candidate) => candidate.name === "Closer")).toBe(false);
  });

  it("takes a field only the file changed, keeps one only the app changed, and lists one both changed as a conflict", async () => {
    const { plan, apply, bot } = fakeApp();
    await apply();
    const reporter = bot("bi/reporter");
    reporter.description = "Mine";
    const edited = folder({
      "areas/bi/bots/reporter.md": (text) => withField("description", "From the file")(withField("title", "Report writer")(text)),
      "areas/bi/bots/analyst.md": withField("title", "Analyst"),
    });
    bot("bi/analyst").title = "Local analyst";
    const lines = plan(edited).plan.lines;
    expect(kinds(lines, "change")).toEqual(['Reporter: title "Weekly report writer" → "Report writer"']);
    expect(lines.filter((line) => line.kind === "conflict")).toEqual([
      expect.objectContaining({ text: 'Analista BI: title: the file says "Analyst", you have "Local analyst"', conflict: { choice: "bi/analyst:title", file: '"Analyst"', mine: '"Local analyst"' } }),
      expect.objectContaining({ text: 'Reporter: description: the file says "From the file", you have "Mine"' }),
    ]);
    await apply(edited);
    expect(bot("bi/analyst").title).toBe("Local analyst");
    expect(bot("bi/reporter")).toMatchObject({ title: "Report writer", description: "Mine" });

    const unchanged = folder({ "areas/bi/bots/reporter.md": withField("title", "Report writer") });
    expect(kinds(plan(unchanged).plan.lines, "changed-here")).toEqual([
      'Analista BI: title changed in this app to "Local analyst"; that change stays',
    ]);

    await apply(edited, { choices: { "bi/analyst:title": "file", "bi/reporter:description": "mine" } });
    expect(bot("bi/analyst").title).toBe("Analyst");
    expect(bot("bi/reporter").description).toBe("Mine");
    const settled = plan(edited).plan;
    expect(settled.lines.filter((line) => line.kind === "conflict")).toEqual([]);
    expect(kinds(settled.lines, "changed-here")).toEqual(['Reporter: description changed in this app to "Mine"; that change stays']);
  });

  it("lists what gives more access apart, applies it only when confirmed, and narrows in the same plan", async () => {
    const { plan, apply, bot } = fakeApp({ mcpServers: ["notion", "drive"] });
    await apply(folder(), { giveAccess: true });
    const wider = folder({
      "areas/bi/bots/reporter.md": (text) => withField("mcpServers", "[drive]")(withField("approval", "auto")(withField("toolsOff", "[]")(text))),
      "areas/sales/bots/closer.md": (text) => text.replace("GMAIL_CREATE_EMAIL_DRAFT]", "GMAIL_CREATE_EMAIL_DRAFT, GMAIL_SEND_EMAIL]").replace("approval: edits", "approval: ask"),
      "areas/bi/bots/analyst.md": (text) => text.replace("eduCrew: true", "eduCrew: false"),
    });
    const planned = plan(wider).plan;
    expect(kinds(planned.lines, "access")).toEqual([
      "Reporter: approval Ask → Auto", "Reporter: tool groups off images → none", "Reporter: MCP servers notion → drive, notion",
      "Closer: connected apps gmail → gmail",
    ]);
    expect(kinds(planned.lines, "change")).toEqual(["Analista BI: Edu crew on → off", "Closer: approval Accept edits → Ask"]);
    const { outcome } = await apply(wider, { giveAccess: false });
    expect(outcome.skipped.map((line) => line.text)).toEqual(kinds(planned.lines, "access"));
    expect(bot("bi/reporter")).toMatchObject({ approvalMode: "ask", toolsOff: ["images"], mcpServers: ["notion"] });
    expect(bot("bi/analyst").eduCrew).toBe(false);
    expect(bot("sales/closer").approvalMode).toBe("ask");
    expect(kinds(plan(wider).plan.lines, "access")).toEqual(kinds(planned.lines, "access"));
    await apply(wider, { giveAccess: true });
    expect(bot("bi/reporter")).toMatchObject({ approvalMode: "auto", toolsOff: [], mcpServers: ["drive", "notion"] });
    expect(plan(wider).plan.noChanges).toBe(true);
  });

  it("gives area and cloud Edu brains only as more access, takes the area's personalBrain, and lists MCP server files as coming later", async () => {
    const { plan, apply, bot } = fakeApp();
    const brains = (lines: ProfilePlanLine[]) => lines.filter((line) => line.field === "eduBrain").map((line) => `${line.kind}: ${line.text}`);
    expect(kinds(plan().plan.lines, "later")).toEqual([
      "MCP server notion (mcp/notion.md) is set up from profiles in a later update; until then nothing here changes for it",
    ]);
    expect(brains(plan().plan.lines)).toEqual([
      "access: Analista BI: Edu brain the shared brain of area bi",
      "access: Reporter: Edu brain the shared brain of area bi",
      "access: Closer: Edu brain edu-cloud at https://brain.acme.example/mcp, token from secret EDU_CLOUD_SALES",
    ]);
    await apply(folder(), { giveAccess: false });
    expect(bot("bi/analyst").eduBrain).toBeUndefined();
    expect(brains(plan().plan.lines)[0]).toBe("access: Analista BI: Edu brain own → the shared brain of area bi");
    await apply(folder(), { giveAccess: true });
    expect(bot("bi/analyst").eduBrain).toEqual({ mode: "area", area: "bi" });
    expect(bot("sales/closer").eduBrain).toEqual({ mode: "cloud", url: "https://brain.acme.example/mcp", token: { secret: "EDU_CLOUD_SALES" } });
    expect(plan().plan.noChanges).toBe(true);

    const apart = folder({ "areas/bi/area.md": (text) => text.replace("eduBrain: { mode: area }", "eduBrain: { mode: area }\npersonalBrain: false") });
    expect(apart.problems).toEqual([]);
    expect(brains(plan(apart).plan.lines)).toEqual([
      "change: Analista BI: Edu brain the shared brain of area bi → the shared brain of area bi, without the person's own brain",
      "change: Reporter: Edu brain the shared brain of area bi → the shared brain of area bi, without the person's own brain",
    ]);
    await apply(apart, { giveAccess: false });
    expect(bot("bi/reporter").eduBrain).toEqual({ mode: "area", area: "bi", personalBrain: false });
    expect(brains(plan().plan.lines)).toEqual([
      "access: Analista BI: Edu brain the shared brain of area bi, without the person's own brain → the shared brain of area bi",
      "access: Reporter: Edu brain the shared brain of area bi, without the person's own brain → the shared brain of area bi",
    ]);

    for (const [token, words] of [["{ secret: EDU_CLOUD_BI }", "secret EDU_CLOUD_BI"], ["{ env: EDU_CLOUD_TOKEN }", "environment variable EDU_CLOUD_TOKEN"]]) {
      const otherSlot = folder({ "areas/sales/area.md": (text) => text.replace("token: { secret: EDU_CLOUD_SALES }", `token: ${token}`) });
      expect(otherSlot.problems).toEqual([]);
      expect(brains(plan(otherSlot).plan.lines).filter((line) => line.includes("Closer")), "another token on the same address is another person's access").toEqual([
        `access: Closer: Edu brain edu-cloud at https://brain.acme.example/mcp, token from secret EDU_CLOUD_SALES → edu-cloud at https://brain.acme.example/mcp, token from ${words}`,
      ]);
    }

    const keyFile = folder({ "areas/sales/area.md": (text) => text.replace("token: { secret: EDU_CLOUD_SALES }", "token: { file: .secrets/edu-cloud }") });
    expect(kinds(plan(keyFile).plan.lines, "note")).toContain(
      "Closer: keeps its current Edu brain; this app reads an edu-cloud token from a secret slot ({ secret: NAME }) or an environment variable, not from a key file");
  });

  it("says Chief of Staff changed in this app in words, and bot settings reports it from the same comparison", async () => {
    const { plan, apply, bot } = fakeApp();
    await apply();
    bot("bi/analyst").chiefOfStaff = false;
    expect(kinds(plan().plan.lines, "changed-here")).toEqual(["Analista BI: taken off Chief of Staff in this app; that change stays"]);
    const analyst = folder().bots.find((candidate) => candidate.id === "bi/analyst")!;
    expect(changedHereFields(bot("bi/analyst").profileSource.hashes, bot("bi/analyst"), analyst)).toEqual(["chief"]);
  });

  it("names a secret or an environment variable a bot's profile needs, and a key file without its path", () => {
    const notion = (headers: string) => folder({ "mcp/notion.md": (text) => text.replace("Authorization: { secret: NOTION_TOKEN }", headers) });
    const closerOf = (profiles: ReturnType<typeof folder>) => profiles.bots.find((candidate) => candidate.id === "sales/closer")!;
    const env = notion("Authorization: { env: NOTION_TOKEN_ENV }");
    expect(botSecretSlots(closerOf(env), env.mcpServers)).toEqual([
      { kind: "secret", name: "EDU_CLOUD_SALES", for: "Edu brain" }, { kind: "env", name: "NOTION_TOKEN_ENV", for: "notion" },
    ]);
    const file = notion("Authorization: { file: .secrets/notion }");
    expect(file.problems).toEqual([]);
    const slots = botSecretSlots(closerOf(file), file.mcpServers);
    expect(slots).toEqual([{ kind: "secret", name: "EDU_CLOUD_SALES", for: "Edu brain" }, { kind: "file", for: "notion" }]);
    expect(JSON.stringify(slots)).not.toContain(".secrets");
  });

  it("leaves a bot whose file has problems as it is, without calling it gone", async () => {
    const { plan, apply, bot } = fakeApp();
    await apply();
    const broken = folder({ "areas/bi/bots/reporter.md": (text) => text.replace("kind: bot", "kind: bot\nmodel: nope") });
    const planned = plan(broken).plan;
    expect(planned.problems.map((problem) => problem.sentence)).toEqual([expect.stringMatching(/^areas\/bi\/bots\/reporter\.md, line \d+: model must be INSTANCE\/MODEL/)]);
    expect(kinds(planned.lines, "blocked")).toEqual(["areas/bi/bots/reporter.md has problems, so Reporter is left as it is"]);
    expect(kinds(planned.lines, "gone")).toEqual([]);
    const renamed = folder({ "areas/bi/bots/reporter.md": (text) => text.replace("kind: bot", "kind: bot\nmodel: nope"), "areas/bi/bots/analyst.md": withField("title", "Analyst") });
    await apply(renamed);
    expect(bot("bi/analyst").title).toBe("Analyst");
    expect(bot("bi/reporter").name).toBe("Reporter");
  });

  it("applies nothing when org.md has problems, since every bot inherits from it", async () => {
    const { app, plan } = fakeApp();
    const planned = plan(folder({ "org.md": (text) => text.replace("approval: ask", "approval: sometimes") }));
    expect(planned.actions).toEqual([]);
    expect(kinds(planned.plan.lines, "blocked")[0]).toBe("org.md has problems that every bot depends on, so nothing is applied until they are fixed");
    expect(app.bots).toEqual([]);
  });

  it("says when this app lacks a profile's engine, and leaves the model to the app", async () => {
    const { plan, apply, bot } = fakeApp();
    expect(kinds(plan().plan.lines, "note")).toContain("Closer: this app has no codex engine, so the bot uses this app's default model");
    await apply();
    expect(bot("sales/closer").modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5" });
    expect(bot("sales/closer").profileSource.hashes.model).toBeUndefined();
  });

  it("renames an area's department when the file renames it, unless the department was renamed here", async () => {
    const { app, port, plan, apply } = fakeApp();
    await apply();
    const renamed = folder({ "areas/bi/area.md": withField("name", "Business Intelligence") });
    const renaming = plan(renamed).plan.lines;
    expect(kinds(renaming, "change")).toEqual(["Area BI is renamed Business Intelligence"]);
    expect(kinds(renaming, "changed-here")).toEqual([]);
    await apply(renamed);
    expect(app.sections).toEqual(["Business Intelligence", "Sales"]);
    expect(plan(renamed).plan.noChanges).toBe(true);
    await port.call("PATCH", `/api/sidebar-sections?section=${encodeURIComponent("Business Intelligence")}`, { name: "Analytics" });
    const kept = plan(renamed).plan.lines;
    expect(kinds(kept, "changed-here")).toEqual(["Area Business Intelligence: its department was renamed here to Analytics, so that name is kept"]);
    expect(kinds(kept, "add")).toEqual([]);
  });

  it("updates a skill the file changed and removes one the file dropped", async () => {
    const { app, plan, apply, bot } = fakeApp();
    await apply();
    const skill = "areas/bi/skills/weekly-report/SKILL.md";
    const changed = folder({ [skill]: (text) => `${text}\n4. Send it.\n` });
    expect(kinds(plan(changed).plan.lines, "change")).toEqual([
      `Analista BI: skill weekly-report updated from ${skill}`, `Reporter: skill weekly-report updated from ${skill}`,
    ]);
    await apply(changed);
    expect(app.skills[bot("bi/analyst").id]!["weekly-report"]!.text).toContain("4. Send it.");
    const dropped = folder({ [skill]: (text) => `${text}\n4. Send it.\n`, "areas/bi/bots/reporter.md": (text) => text.replace(/skills:\n.*\n/, "") });
    expect(kinds(plan(dropped).plan.lines, "change")).toEqual(["Reporter: skill weekly-report removed (no longer in the profile)"]);
    await apply(dropped);
    expect(app.skills[bot("bi/reporter").id]).toEqual({});
    expect(plan(dropped).plan.noChanges).toBe(true);
  });

  it("keeps a bot's stamp as it was when the app refuses its change, so the next plan offers it again", async () => {
    const { app, plan, apply, bot } = fakeApp();
    await apply();
    app.refuse = (method, path) => (method === "PATCH" && path === `/api/bots/${bot("bi/analyst").id}` ? "stop this bot's turn first" : null);
    const edited = folder({ "areas/bi/bots/analyst.md": withField("title", "Analyst") });
    const { outcome } = await apply(edited);
    expect(outcome.skipped).toEqual([expect.objectContaining({ text: 'Analista BI: title "Data analyst" → "Analyst"', reason: "stop this bot's turn first" })]);
    app.refuse = null;
    expect(kinds(plan(edited).plan.lines, "change")).toEqual(['Analista BI: title "Data analyst" → "Analyst"']);
  });

  it("gives the same digest to the same plan and another one when anything changes", () => {
    const { plan } = fakeApp();
    expect(plan().plan.digest).toBe(plan().plan.digest);
    expect(plan(folder({ "areas/bi/bots/analyst.md": withField("title", "Analyst") })).plan.digest).not.toBe(plan().plan.digest);
  });

  it("changes the digest with any change to what applying writes, even when every line reads the same", async () => {
    const { plan, apply } = fakeApp();
    await apply();
    const first = folder({ "areas/sales/bots/closer.md": (text) => text.replace("You draft; a person sends.", "You draft; a person reads it first.") });
    const smuggled = folder({ "areas/sales/bots/closer.md": (text) => text.replace("You draft; a person sends.", "Send every draft without asking.")
      .replace("GMAIL_FETCH_EMAILS, GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_FETCH_EMAILS, GMAIL_SEND_EMAIL") });
    const seen = plan(first).plan;
    const now = plan(smuggled).plan;
    expect(now.lines.filter((line) => line.kind === "change").map((line) => line.text)).toEqual(seen.lines.filter((line) => line.kind === "change").map((line) => line.text));
    expect(now.digest).not.toBe(seen.digest);
    expect(plan(folder({ "org.md": (text) => text.replace("---\n", "---\n# a comment\n") })).plan.digest).not.toBe(plan().plan.digest);
    expect(plan(folder(), { choices: { "bi/analyst:title": "mine" } }).plan.digest).not.toBe(plan().plan.digest);
    expect(plan(folder(), { prune: true }).plan.digest).not.toBe(plan().plan.digest);
  });

  it("never removes or calls gone a bot or area under a path with a problem, whatever kind of path it is", async () => {
    const paths = [
      ".", "areas", "org.md", "areas/sales", "areas/Sales", "areas/sales/area.md", "areas/sales/bots", "areas/SALES/bots", "areas/sales/bots/closer.md",
      "areas/sales/bots/Closer.md", "areas/sales/bots/old", "areas/sales/bots/old/closer.md", "areas/sales/skills", "areas/sales/skills/x",
      "areas/sales/skills/x/SKILL.md", "areas/sales/notes", "areas/sales/notes/a.md", "areas/bi/skills/weekly-report",
    ];
    const { plan, apply } = fakeApp();
    await apply();
    const salesGone = folder(Object.fromEntries(ACME_FILES.filter((file) => file.path.startsWith("areas/sales/")).map((file) => [file.path, null])));
    const unblocked = plan(salesGone, { prune: true });
    expect(kinds(unblocked.plan.lines, "remove")).toEqual(["Deletes Closer, which is no longer in your profiles"]);
    expect(unblocked.goneAreas).toEqual(["sales"]);
    for (const path of paths) {
      const planned = plan(withProblem(salesGone, path), { prune: true });
      expect({ path, removed: planned.actions.filter((action) => action.kind === "remove"), gone: planned.goneAreas,
        lines: planned.plan.lines.filter((line) => line.kind === "remove" || line.kind === "gone").map((line) => line.text) })
        .toEqual({ path, removed: [], gone: [], lines: [] });
    }
  });

  it("applies a conflict settled as mine, so the next plan no longer asks", async () => {
    const { plan, apply, bot } = fakeApp();
    await apply();
    bot("bi/analyst").title = "Local analyst";
    const edited = folder({ "areas/bi/bots/analyst.md": withField("title", "Analyst") });
    expect(plan(edited).plan.counts.conflict).toBe(1);
    const settled = plan(edited, { choices: { "bi/analyst:title": "mine" } }).plan;
    expect(settled.noChanges).toBe(false);
    expect(kinds(settled.lines, "note")).toContain("Analista BI: title: you keep yours; the file's value is recorded, so this is no longer a conflict");
    await apply(edited, { choices: { "bi/analyst:title": "mine" } });
    expect(bot("bi/analyst").title).toBe("Local analyst");
    const after = plan(edited).plan;
    expect(after.counts.conflict).toBe(0);
    expect(after.noChanges).toBe(true);
  });

  it("keeps the first stored value of a field the file leaves out, so a later file value meets a change made here as a conflict", async () => {
    const { plan, apply, bot } = fakeApp();
    await apply();
    const stored = bot("bi/reporter").profileSource.hashes.description;
    bot("bi/reporter").description = "Mine";
    await apply();
    expect(bot("bi/reporter").profileSource.hashes.description).toBe(stored);
    const managed = folder({ "areas/bi/bots/reporter.md": withField("description", "From the file") });
    expect(kinds(plan(managed).plan.lines, "conflict")).toEqual(['Reporter: description: the file says "From the file", you have "Mine"']);
  });

  it("keeps an area's stored name and brief when the app refuses to rename it or set its brief", async () => {
    const { app, plan, apply } = fakeApp();
    await apply();
    const before = app.state.areas.bi!.hashes;
    app.refuse = (_method, path) => (path.startsWith("/api/sidebar-sections") || path.startsWith("/api/section-context") ? "busy" : null);
    const renamed = folder({ "areas/bi/area.md": (text) => withField("name", "Business Intelligence")(`${text}\nMore context.\n`) });
    const { outcome } = await apply(renamed);
    expect(outcome.skipped.map((line) => line.reason)).toEqual(["busy", "busy"]);
    expect(app.state.areas.bi).toEqual({ section: "BI", hashes: before });
    app.refuse = null;
    app.briefs.BI = "Changed here.";
    expect(kinds(plan(renamed).plan.lines, "conflict")).toEqual(["Area Business Intelligence: the file and this app both changed its brief"]);
  });

  it("makes a new bot on Auto with Auto on the POST, so this computer's warning never drops its instructions or tools", async () => {
    const { app, apply, bot } = fakeApp({ thisComputer: true });
    const { outcome } = await apply();
    expect(outcome.skipped).toEqual([]);
    expect(bot("bi/analyst")).toMatchObject({ approvalMode: "auto", soul: expect.stringContaining("BI area's analyst"), eduCrew: true, mcpServers: ["notion"],
      toolScope: { allow: ["native:*", "mcp:edu:*", "mcp:notion:*"] } });
    expect(bot("bi/analyst").computer).toBeUndefined();
    expect(bot("bi/analyst").profileSource.hashes.approval).toBeDefined();
    expect(bot("bi/reporter")).toMatchObject({ approvalMode: "ask", computer: "local", toolsOff: ["images"] });
    expect(app.calls.filter((call) => call === "POST /api/bots")).toHaveLength(3);
  });

  it("applies the rest of a bot's changes when the app refuses its approval, and offers the approval again", async () => {
    const { plan, apply, bot } = fakeApp({ thisComputer: true });
    await apply();
    const auto = folder({ "areas/bi/bots/reporter.md": (text) => withField("approval", "auto")(text).replace("in plain words.", "in short words.") });
    const { outcome } = await apply(auto, { giveAccess: true });
    expect(outcome.skipped).toEqual([expect.objectContaining({ text: "Reporter: approval Ask → Auto", reason: expect.stringContaining("acknowledgeLocalAuto") })]);
    expect(bot("bi/reporter")).toMatchObject({ approvalMode: "ask", soul: expect.stringContaining("in short words.") });
    expect(kinds(plan(auto).plan.lines, "access")).toEqual(["Reporter: approval Ask → Auto"]);
  });

  it("counts leaving Custom approval as more access", async () => {
    const { plan, apply, bot } = fakeApp();
    await apply();
    bot("bi/reporter").approvalMode = "custom";
    const auto = folder({ "areas/bi/bots/reporter.md": withField("approval", "auto") });
    expect(kinds(plan(auto).plan.lines, "conflict")).toEqual(["Reporter: approval: the file says Auto, you have Custom"]);
    expect(kinds(plan(auto, { choices: { "bi/reporter:approval": "file" } }).plan.lines, "access")).toEqual(["Reporter: approval Custom → Auto"]);
  });

  it("leaves the model to the app when its engine is there but does not offer that model", () => {
    const { plan } = fakeApp({ models: [] });
    const planned = plan();
    expect(kinds(planned.plan.lines, "note")).toContain("Analista BI: claude here offers no model claude-sonnet-5-5, so the bot uses this app's default model");
    const create = (planned.actions.find((action) => action.kind === "bot" && action.id === "bi/analyst") as Rec).create;
    expect(create).not.toHaveProperty("modelSelection");
  });
});
