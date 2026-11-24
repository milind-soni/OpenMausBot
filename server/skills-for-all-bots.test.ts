import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts resolves DATA_DIR at import time; isolate before importing.
process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "omb-all-bots-"));

const skills = await import("./skills.ts");
const library = await import("./skill-library.ts");
const everywhere = await import("./skills-for-all-bots.ts");
const ops = await import("./skills-for-all-bots-ops.ts");
const { createSkillsForAllBotsHost } = await import("./host/skills-for-all-bots-host.ts");
const { createSkillSwitchHost } = await import("./host/skill-switch-host.ts");
const { requesterScope } = await import("./routes/skills-for-all-bots.ts");
const { learnSource } = await import("./skill-learn.ts");
const { flushDecisionLog } = await import("./decision-log.ts");
const { personKey } = await import("./person-key.ts");
const { DATA_DIR } = await import("./config.ts");

type Bot = { id: string; name: string; color: string; createdBy?: string; reportsTo?: string; home?: unknown };

const SKILL = (name: string, body = "Do the thing.", description = "Sets up a new client the way this person does.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
/** A path as the index line writes it: inside JSON quotes, so Windows backslashes come doubled. */
const quoted = (path: string) => JSON.stringify(path).slice(1, -1);
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
let bots: Bot[] = [];

function wire(team = false) {
  everywhere.wireSkillsForAllBots({ team, bot: (id) => bots.find((bot) => bot.id === id), bots: () => bots });
}
function bot(name: string, more: Partial<Bot> = {}): Bot {
  const made = { id: unique(name.toLowerCase()), name, color: "blue", ...more };
  bots.push(made);
  return made;
}
function learn(botId: string, name: string, body?: string) {
  const staged = skills.stageSkillWrite(botId, { action: "create", files: [{ path: "SKILL.md", content: SKILL(name, body) }], source: learnSource("conversation") });
  if ("error" in staged) throw new Error(staged.error);
  const applied = skills.applyStagedSkillWrite(botId, staged.id, { expectedSha256: staged.sha256 });
  if ("error" in applied) throw new Error(applied.error);
}
const names = (botId: string, library?: string[]) => skills.resolveBotSkills(botId, library).filter((skill) => skill.enabled).map((skill) => skill.name);
const indexLines = (botId: string, name: string) => skills.skillsSystemPrompt(botId).split("\n").filter((line) => line.startsWith(`- ${name}:`));
function putFrom(botId: string, name: string) {
  const copy = ops.ownCopy(botId, name);
  if (!copy) throw new Error("no own copy");
  const put = ops.putOnAllBots(everywhere.allBotsScopeOfBot(bots.find((one) => one.id === botId))!, name, copy, { fresh: true });
  if ("error" in put) throw new Error(put.error);
  return put;
}

beforeEach(() => {
  bots = [];
  rmSync(join(DATA_DIR, "skills-for-all-bots"), { recursive: true, force: true });
  wire();
});
afterEach(() => everywhere.wireSkillsForAllBots(null));

describe("a skill on all of the person's bots", () => {
  it("reaches every bot, a bot made later too, with one index line each, and leaves with one removal", () => {
    const chief = bot("Chief"), writer = bot("Writer"), keeper = bot("Keeper");
    learn(chief.id, "client-onboarding");
    learn(keeper.id, "client-onboarding", "Keeper's own different way.");
    const put = putFrom(chief.id, "client-onboarding");
    expect(put.retired.map((one) => one.botId)).toEqual([chief.id]);
    expect(put.kept).toEqual([keeper.id]);
    expect(skills.listSkills(chief.id)).toEqual([]);

    const later = bot("Later");
    for (const one of [chief, writer, later]) {
      expect(names(one.id)).toEqual(["client-onboarding"]);
      const lines = indexLines(one.id, "client-onboarding");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(quoted(join(DATA_DIR, "skills-for-all-bots", "mine", "skills", "client-onboarding", "SKILL.md")));
    }
    // The bot with its own different copy keeps it: its own skill wins the name.
    expect(skills.resolveBotSkills(keeper.id, undefined).filter((skill) => skill.name === "client-onboarding")).toHaveLength(1);
    expect(indexLines(keeper.id, "client-onboarding")[0]).toContain(quoted(join("workspaces", keeper.id)));
    expect(skills.enabledSkillFile(writer.id, "client-onboarding")).toBe(everywhere.allBotsSkillFile(writer.id, "client-onboarding"));

    const removed = ops.removeFromAllBots("mine", "client-onboarding");
    expect("removed" in removed).toBe(true);
    for (const one of [chief, writer, later]) expect(names(one.id)).toEqual([]);
    expect(names(keeper.id)).toEqual(["client-onboarding"]);
  });

  it("turns off for one bot only, and an identical copy that was off stays off there", () => {
    const chief = bot("Chief"), writer = bot("Writer"), quiet = bot("Quiet");
    learn(chief.id, "weekly-report");
    learn(quiet.id, "weekly-report");
    skills.setSkillEnabled(quiet.id, "weekly-report", false);
    const put = putFrom(chief.id, "weekly-report");
    expect(put.retired.map((one) => [one.botId, one.wasOff])).toEqual([[chief.id, false], [quiet.id, true]]);
    expect(names(quiet.id)).toEqual([]);
    everywhere.setAllBotsSkillOff(writer.id, "weekly-report", true);
    expect(names(writer.id)).toEqual([]);
    expect(indexLines(writer.id, "weekly-report")).toEqual([]);
    expect(names(chief.id)).toEqual(["weekly-report"]);
    everywhere.setAllBotsSkillOff(writer.id, "weekly-report", false);
    expect(names(writer.id)).toEqual(["weekly-report"]);
  });

  it("with the library on too, a name in both shows once and is the person's all-bots copy", () => {
    const chief = bot("Chief");
    const libraryRoot = library.skillsLibraryRoot();
    const installed = library.installLibrarySkill({ name: "release-notes", instructions: SKILL("release-notes", "Library way.", "The library's copy."), source: "test", reviewState: "approved", root: libraryRoot });
    if ("error" in installed) throw new Error(installed.error);
    library.setLibrarySkillEveryBot("release-notes", true, libraryRoot);
    expect(skills.resolveBotSkills(chief.id, []).map((skill) => skill.name)).toEqual(["release-notes"]);
    learn(chief.id, "release-notes", "The person's way.");
    putFrom(chief.id, "release-notes");
    const listed = skills.resolveBotSkills(chief.id, []).filter((skill) => skill.name === "release-notes");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ allBots: true, description: "Sets up a new client the way this person does." });
    expect(skills.listBotSkillsWithOrigin(chief.id, []).skills.map((skill) => [skill.name, skill.origin])).toEqual([["release-notes", "all-bots"]]);
    expect(skills.enabledSkillFile(chief.id, "release-notes", [])).toBe(everywhere.allBotsSkillFile(chief.id, "release-notes"));
    expect(skills.skillsSystemPrompt(chief.id, []).split("\n").filter((line) => line.startsWith("- release-notes:"))).toEqual([
      expect.stringContaining(quoted(join("skills-for-all-bots", "mine"))),
    ]);
    ops.removeFromAllBots("mine", "release-notes");
    expect(skills.resolveBotSkills(chief.id, [])[0]).not.toHaveProperty("allBots");
    library.retireLibrarySkill("release-notes", library.readSkillLibraryIndex(libraryRoot)["release-notes"]!.sha256, libraryRoot);
  });
});

describe("on a Team Cloud, all my bots is the member's own bots only", () => {
  it("never reaches another member's bot or a team bot nobody owns, and a stand-in has none", () => {
    wire(true);
    const alicesChief = bot("Alice's Chief", { createdBy: "alice@acme.test" });
    const alicesWriter = bot("Alice's Writer", { createdBy: "bob@acme.test", reportsTo: "Alice@Acme.test" });
    const bobs = bot("Bob's bot", { createdBy: "bob@acme.test" });
    const team = bot("Team bot");
    const standIn = bot("Elsewhere", { createdBy: "alice@acme.test", home: { place: "p", placeName: "Laptop", botId: "x" } });
    expect(everywhere.allBotsScopeOfBot(team)).toBeNull();
    expect(everywhere.allBotsScopeOfBot(standIn)).toBeNull();
    learn(alicesChief.id, "client-onboarding");
    putFrom(alicesChief.id, "client-onboarding");
    expect(names(alicesChief.id)).toEqual(["client-onboarding"]);
    expect(names(alicesWriter.id)).toEqual(["client-onboarding"]);
    for (const other of [bobs, team, standIn]) expect(names(other.id)).toEqual([]);

    const session = (email?: string) => ({ kind: "session", session: { email }, via: "bearer", scopes: ["client"] }) as never;
    expect(requesterScope(alicesWriter as never, session("alice@acme.test"))).toEqual({ scope: everywhere.allBotsScopeOfPerson("alice@acme.test", true) });
    expect(requesterScope(alicesWriter as never, session("bob@acme.test"))).toMatchObject({ status: 403 });
    expect(requesterScope(alicesWriter as never, session())).toMatchObject({ status: 403 });
    expect(requesterScope(alicesWriter as never, { kind: "loopback", scopes: ["admin"] } as never)).toMatchObject({ status: 403 });
    expect(requesterScope(team as never, session("alice@acme.test"))).toMatchObject({ status: 409 });
  });
});

describe("skill_manage for all the person's bots", () => {
  const dataDirs: string[] = [];
  afterEach(async () => {
    for (const dir of dataDirs.splice(0)) await flushDecisionLog(dir);
  });
  function host(direct: boolean) {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-all-bots-host-"));
    dataDirs.push(dataDir);
    const messages: Array<{ id: string; card: any }> = [];
    const made = createSkillsForAllBotsHost({
      store: {
        bot: (id: string) => bots.find((one) => one.id === id) as never,
        appendMessage: ((_thread: string, message: { card: unknown }) => { messages.push({ id: `m${messages.length}`, card: message.card }); }) as never,
        patchMessage: ((_thread: string, id: string, patch: { card: unknown }) => { messages.find((one) => one.id === id)!.card = patch.card; }) as never,
      },
      dataDir,
      persistence: () => ({ ok: true }),
      noteSkillChange: vi.fn(),
    });
    const call = (from: Bot, body: Record<string, unknown>, actsFor: string | null = null) =>
      made.stage(from as never, "t1", body, () => (direct ? "full-access" : null), async (asked) => asked, () => true, () => actsFor);
    const last = () => messages.at(-1)!;
    const undo = (from: Bot) => made.undo(from.id, "t1", last() as never, last().card.skillRequest);
    const answer = (from: Bot, behavior: "allow" | "deny") =>
      made.resolve({ botId: from.id, threadId: "t1", requestId: last().card.requestId, behavior, reviewedSha256: last().card.skillRequest.sha256 }, last().id, last().card, last().card.skillRequest);
    return { call, last, undo, answer, messages };
  }

  it("creates on every bot in one call with a receipt, and Undo gives each bot back what it had", async () => {
    const chief = bot("Chief"), writer = bot("Writer"), quiet = bot("Quiet");
    learn(quiet.id, "client-onboarding");
    skills.setSkillEnabled(quiet.id, "client-onboarding", false);
    const { call, last, undo } = host(true);
    const result = await call(chief, { action: "create", all_bots: true, skill_md: SKILL("client-onboarding"), source: "conversation" });
    expect(result).toMatchObject({ status: 201, body: { state: "applied", allBots: true, name: "client-onboarding" } });
    expect(last().card).toMatchObject({ autoApplied: true, title: 'Skill "client-onboarding" is on all your bots', skillRequest: { allBots: true, action: "create" } });
    expect([names(chief.id), names(writer.id), names(quiet.id)]).toEqual([["client-onboarding"], ["client-onboarding"], []]);
    expect(skills.listSkills(quiet.id)).toEqual([]);

    expect(undo(chief)).toEqual({ claimed: true, state: "undone" });
    expect([names(chief.id), names(writer.id)]).toEqual([[], []]);
    expect(skills.listSkills(quiet.id).map((skill) => [skill.name, skill.enabled])).toEqual([["client-onboarding", false]]);
    expect(everywhere.allBotsSkillOffs(quiet.id).has("client-onboarding")).toBe(false);
  });

  it("updates and deletes a shared skill by its name alone, and Undo restores it", async () => {
    const chief = bot("Chief"), writer = bot("Writer");
    const { call, undo } = host(true);
    await call(chief, { action: "create", all_bots: true, skill_md: SKILL("weekly-report"), source: "conversation" });
    const updated = await call(writer, { action: "update", skill_name: "weekly-report", skill_md: SKILL("weekly-report", "New way."), source: "conversation" });
    expect(updated).toMatchObject({ status: 201, body: { state: "applied", action: "update" } });
    expect(skills.enabledSkillFile(chief.id, "weekly-report")).toBeTruthy();
    expect(ops.sharedCopy("mine", "weekly-report")?.skillMd).toContain("New way.");
    expect(undo(writer)).toEqual({ claimed: true, state: "undone" });
    expect(ops.sharedCopy("mine", "weekly-report")?.skillMd).toContain("Do the thing.");

    everywhere.setAllBotsSkillOff(writer.id, "weekly-report", true);
    const deleted = await call(chief, { action: "delete", skill_name: "weekly-report" });
    expect(deleted).toMatchObject({ status: 201, body: { state: "applied", action: "delete" } });
    expect(names(chief.id)).toEqual([]);
    expect(undo(chief)).toEqual({ claimed: true, state: "undone" });
    expect(names(chief.id)).toEqual(["weekly-report"]);
    expect(names(writer.id)).toEqual([]); // its own switch came back with it
    ops.removeFromAllBots("mine", "weekly-report");
  });

  it("waits on a card where the bot's own skill changes would, and applies only on approval", async () => {
    const chief = bot("Chief"), writer = bot("Writer");
    const { call, last, answer } = host(false);
    expect(await call(chief, { action: "create", all_bots: true, skill_md: SKILL("invoice-check"), source: "conversation" })).toMatchObject({ status: 201, body: { state: "pending" } });
    expect(last().card).toMatchObject({ options: ["Enable", "Deny"], title: 'Put skill "invoice-check" on all your bots?' });
    expect(names(writer.id)).toEqual([]);
    expect(answer(chief, "allow")).toEqual({ claimed: true, outcome: "allowed-once" });
    expect(names(writer.id)).toEqual(["invoice-check"]);
    await call(chief, { action: "delete", skill_name: "invoice-check" });
    expect(answer(chief, "deny")).toEqual({ claimed: true, outcome: "rejected" });
    expect(names(writer.id)).toEqual(["invoice-check"]);
    ops.removeFromAllBots("mine", "invoice-check");
  });

  it("leaves the bot's own skills to the usual paths, and refuses a team bot nobody owns", async () => {
    const chief = bot("Chief");
    learn(chief.id, "own-thing");
    const { call } = host(true);
    expect(await call(chief, { action: "update", skill_name: "own-thing", skill_md: SKILL("own-thing"), source: "conversation" })).toBeNull();
    expect(await call(chief, { action: "create", skill_md: SKILL("solo"), source: "conversation" })).toBeNull();
    wire(true);
    const nobodys = bot("Department Chief");
    expect(await call(nobodys, { action: "create", all_bots: true, skill_md: SKILL("x-skill"), source: "conversation" })).toMatchObject({ status: 422 });
  });

  it("on a Team Cloud, changes a member's bots only in a turn that acts for that member", async () => {
    wire(true);
    const alicesChief = bot("Alice's Chief", { createdBy: "alice@acme.test" });
    const alicesWriter = bot("Alice's Writer", { createdBy: "alice@acme.test" });
    const { call } = host(true);
    const create = { action: "create", all_bots: true, skill_md: SKILL("team-thing"), source: "conversation" };
    // A teammate chatting with Alice's shared bot, and a routine acting for nobody, cannot reach all of Alice's bots.
    expect(await call(alicesChief, create, personKey({ id: "", email: "bob@acme.test" }))).toMatchObject({ status: 403 });
    expect(await call(alicesChief, create, null)).toMatchObject({ status: 403 });
    expect(names(alicesWriter.id)).toEqual([]);
    expect(await call(alicesChief, create, personKey({ id: "", email: "alice@acme.test" }))).toMatchObject({ status: 201, body: { state: "applied" } });
    expect(names(alicesWriter.id)).toEqual(["team-thing"]);
  });

  it("an update keeps the reference files it does not mention, and an empty one removes that file", async () => {
    const chief = bot("Chief");
    const { call } = host(true);
    const references = [{ path: "references/steps.md", content: "# Steps\n\nOne, two.\n" }, { path: "references/tone.md", content: "# Tone\n\nPlain.\n" }];
    await call(chief, { action: "create", all_bots: true, skill_md: SKILL("with-notes"), references, source: "conversation" });
    await call(chief, { action: "update", skill_name: "with-notes", skill_md: SKILL("with-notes", "New way."), source: "conversation" });
    expect(ops.sharedCopy("mine", "with-notes")?.files.map((file) => file.path)).toEqual(["references/steps.md", "references/tone.md"]);
    await call(chief, { action: "update", skill_name: "with-notes", skill_md: SKILL("with-notes", "Newer way."), references: [{ path: "references/tone.md", content: "" }], source: "conversation" });
    expect(ops.sharedCopy("mine", "with-notes")).toMatchObject({ files: [{ path: "references/steps.md" }] });
    expect(ops.sharedCopy("mine", "with-notes")?.skillMd).toContain("Newer way.");
  });

  it("switches a shared skill on or off for the asking bot only", () => {
    const chief = bot("Chief"), writer = bot("Writer");
    learn(chief.id, "tidy-inbox");
    putFrom(chief.id, "tidy-inbox");
    const dataDir = mkdtempSync(join(tmpdir(), "omb-all-bots-switch-"));
    dataDirs.push(dataDir);
    const switches = createSkillSwitchHost({
      store: { bot: (id: string) => bots.find((one) => one.id === id) as never, appendMessage: (() => {}) as never, patchMessage: (() => {}) as never },
      dataDir, persistence: () => ({ ok: true }),
      listBotSkills: (one) => skills.resolveBotSkills(one.id, undefined),
      readBotSkillFile: (one, name) => everywhere.readAllBotsSkillFile(one.id, name),
      noteSkillChange: vi.fn(),
    });
    expect(switches.stage(writer as never, "t1", "disable", { skill_name: "tidy-inbox" }, "full-access")).toMatchObject({ status: 201, body: { state: "applied" } });
    expect(names(writer.id)).toEqual([]);
    expect(names(chief.id)).toEqual(["tidy-inbox"]);
  });
});
