import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { requesterScope, withAllBotsOffer } = await import("./routes/skills-for-all-bots.ts");
const { learnSource } = await import("./skill-learn.ts");
const { flushDecisionLog } = await import("./decision-log.ts");
const { personKey } = await import("./person-key.ts");
const { workspaceDir } = await import("./workspace.ts");
const { saveWorkflowSkill, workflowSkillsPrompt } = await import("./skill-burger/store.ts");
const { DATA_DIR } = await import("./config.ts");

type Bot = { id: string; name: string; color: string; threadId: string; createdBy?: string; reportsTo?: string; home?: unknown };

const SKILL = (name: string, body = "Do the thing.", description = "Sets up a new client the way this person does.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
/** A path as the index line writes it: inside JSON quotes, so Windows backslashes come doubled. */
const quoted = (path: string) => JSON.stringify(path).slice(1, -1);
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
let bots: Bot[] = [];
let sharedWithoutTeam = false;

function wire(team = false) {
  ops.wireAllBotsSkills({ team, sharedWithoutTeam: () => sharedWithoutTeam, bot: (id) => bots.find((bot) => bot.id === id), bots: () => bots });
}
function bot(name: string, more: Partial<Bot> = {}): Bot {
  const made = { id: unique(name.toLowerCase().replace(/[^a-z]/g, "")), name, color: "blue", threadId: unique("t"), ...more };
  bots.push(made);
  return made;
}
function learn(botId: string, name: string, body?: string) {
  const staged = skills.stageSkillWrite(botId, { action: "create", files: [{ path: "SKILL.md", content: SKILL(name, body) }], source: learnSource("conversation") });
  if ("error" in staged) throw new Error(staged.error);
  const applied = skills.applyStagedSkillWrite(botId, staged.id, { expectedSha256: staged.sha256 });
  if ("error" in applied) throw new Error(applied.error);
}
const on = (botId: string) => skills.listSkills(botId).filter((skill) => skill.enabled).map((skill) => skill.name);
const shared = (botId: string) => skills.listSkills(botId).filter((skill) => skill.allBots).map((skill) => skill.name);
const indexLines = (botId: string, name: string) => skills.skillsSystemPrompt(botId).split("\n").filter((line) => line.startsWith(`- ${name}:`));
function putFrom(botId: string, name: string) {
  const copy = ops.ownCopy(botId, name);
  if (!copy) throw new Error("no own copy");
  const put = ops.putOnAllBots(everywhere.allBotsScopeOfBot(bots.find((one) => one.id === botId))!, name, copy);
  if ("error" in put) throw new Error(put.error);
  return put;
}

beforeEach(() => {
  bots = [];
  sharedWithoutTeam = false;
  rmSync(join(DATA_DIR, "skills-for-all-bots"), { recursive: true, force: true });
  wire();
});
afterEach(() => ops.wireAllBotsSkills(null));

describe("a skill on all of the person's bots", () => {
  it("is a copy among each bot's own skills, a bot made later too, readable in its own folder and linked for its engine", () => {
    const chief = bot("Chief"), writer = bot("Writer"), keeper = bot("Keeper");
    learn(chief.id, "client-onboarding");
    learn(keeper.id, "client-onboarding", "Keeper's own different way.");
    expect(putFrom(chief.id, "client-onboarding")).toEqual({ kept: [keeper.id], failed: [] });

    const later = bot("Later");
    for (const one of [chief, writer, later]) {
      expect(shared(one.id)).toEqual(["client-onboarding"]);
      const lines = indexLines(one.id, "client-onboarding");
      expect(lines).toHaveLength(1);
      // Inside the bot's own folder, which a bot box gives back and a move carries: no new path to mount.
      expect(lines[0]).toContain(quoted(join(workspaceDir(one.id), "skills")));
      expect(existsSync(join(workspaceDir(one.id), ".claude", "skills", "client-onboarding", "SKILL.md"))).toBe(true);
    }
    expect(shared(keeper.id)).toEqual([]);
    expect(skills.readSkillFile(keeper.id, "client-onboarding")).toContain("Keeper's own different way.");

    // Removing it takes the copies away, and the bot that had it first keeps the one it had.
    const removed = ops.removeFromAllBots("mine", "client-onboarding");
    expect("removed" in removed && removed.failed).toEqual([]);
    expect([on(chief.id), on(writer.id), on(later.id), on(keeper.id)]).toEqual([["client-onboarding"], [], [], ["client-onboarding"]]);
    expect(shared(chief.id)).toEqual([]);
  });

  it("keeps each bot's switch its own, through an update too", () => {
    const chief = bot("Chief"), writer = bot("Writer");
    learn(chief.id, "weekly-report");
    putFrom(chief.id, "weekly-report");
    skills.setSkillEnabled(writer.id, "weekly-report", false);
    expect([on(chief.id), on(writer.id)]).toEqual([["weekly-report"], []]);
    expect(indexLines(writer.id, "weekly-report")).toEqual([]);
    const put = ops.putOnAllBots("mine", "weekly-report", { skillMd: SKILL("weekly-report", "New way."), files: [], source: "learned:conversation" });
    expect(put).toEqual({ kept: [], failed: [] });
    expect([on(chief.id), on(writer.id)]).toEqual([["weekly-report"], []]);
    expect(skills.readSkillFile(writer.id, "weekly-report")).toContain("New way.");
  });

  it("an update that cannot be stored leaves the copy it would replace on every bot", () => {
    const chief = bot("Chief"), writer = bot("Writer");
    const refs = [{ path: "references/steps.md", content: "# Steps\n" }];
    expect(ops.putOnAllBots("mine", "with-notes", { skillMd: SKILL("with-notes"), files: refs, source: "learned:conversation" })).toEqual({ kept: [], failed: [] });
    const broken = ops.putOnAllBots("mine", "with-notes", { skillMd: SKILL("misnamed"), files: refs, source: "learned:conversation" });
    expect(broken).toMatchObject({ error: expect.stringContaining("misnamed") });
    expect(ops.sharedCopy("mine", "with-notes")?.skillMd).toBe(SKILL("with-notes"));
    expect([shared(chief.id), shared(writer.id)]).toEqual([["with-notes"], ["with-notes"]]);
  });

  it("with no skill on all bots, a listing reads nothing of the store until the store is written", () => {
    const chief = bot("Chief");
    expect(skills.listSkills(chief.id)).toEqual([]);
    // Written behind the cache's back: a listing does not look.
    const root = everywhere.allBotsRoot("mine");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "store.json"), JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }));
    library.installLibrarySkill({ name: "behind", instructions: SKILL("behind"), source: "test", reviewState: "approved", root });
    expect(skills.listSkills(chief.id)).toEqual([]);
    everywhere.forgetAllBotsStore("mine");
    expect(shared(chief.id)).toEqual(["behind"]);
  });

  it("with the library on too, a name in both shows once and is the person's copy", () => {
    const chief = bot("Chief");
    const libraryRoot = library.skillsLibraryRoot();
    const installed = library.installLibrarySkill({ name: "release-notes", instructions: SKILL("release-notes", "Library way.", "The library's copy."), source: "test", reviewState: "approved", root: libraryRoot });
    if ("error" in installed) throw new Error(installed.error);
    library.setLibrarySkillEveryBot("release-notes", true, libraryRoot);
    ops.putOnAllBots("mine", "release-notes", { skillMd: SKILL("release-notes", "The person's way."), files: [], source: "learned:conversation" });
    const listed = skills.resolveBotSkills(chief.id, []).filter((skill) => skill.name === "release-notes");
    expect(listed).toEqual([expect.objectContaining({ allBots: true, description: "Sets up a new client the way this person does." })]);
    expect(skills.listBotSkillsWithOrigin(chief.id, []).skills.map((skill) => [skill.name, skill.origin])).toEqual([["release-notes", "private"]]);
    expect(skills.enabledSkillFile(chief.id, "release-notes", [])).toContain(join(workspaceDir(chief.id), "skills"));
    ops.removeFromAllBots("mine", "release-notes");
    expect(skills.resolveBotSkills(chief.id, [])[0]).toMatchObject({ name: "release-notes", description: "The library's copy." });
    library.retireLibrarySkill("release-notes", library.readSkillLibraryIndex(libraryRoot)["release-notes"]!.sha256, libraryRoot);
  });

  it("gives a saved Skill Burger of the same name no second index line", () => {
    const chief = bot("Chief");
    const root = mkdtempSync(join(tmpdir(), "burger-"));
    const saved = saveWorkflowSkill({ workflow: { version: 1, summary: "Send the weekly report", args: {}, steps: [{ id: "s1", kind: "ai", deterministic: false, label: "Write it", prompt: "Write it." }] } as never, botIds: [chief.id], name: "weekly-report", root });
    if ("error" in saved) throw new Error(saved.error);
    expect(workflowSkillsPrompt(chief.id, root)).toContain("- weekly-report:");
    expect(workflowSkillsPrompt(chief.id, root, new Set(["weekly-report"]))).toBe("");
  });
});

describe("whose bots", () => {
  it("on a Team Cloud: the member's own bots only, never another member's, a bot nobody owns or a stand-in", () => {
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
    expect([shared(alicesChief.id), shared(alicesWriter.id)]).toEqual([["client-onboarding"], ["client-onboarding"]]);
    for (const other of [bobs, team, standIn]) expect(skills.listSkills(other.id)).toEqual([]);

    const session = (email?: string) => ({ kind: "session", session: { email }, via: "bearer", scopes: ["client"] }) as never;
    expect(requesterScope(alicesWriter as never, session("alice@acme.test"))).toEqual({ scope: everywhere.allBotsScopeOfPerson("alice@acme.test", true) });
    expect(requesterScope(alicesWriter as never, session("bob@acme.test"))).toMatchObject({ status: 403 });
    expect(requesterScope(alicesWriter as never, { kind: "loopback", scopes: ["admin"] } as never)).toMatchObject({ status: 403 });
    expect(requesterScope(team as never, session("alice@acme.test"))).toMatchObject({ status: 409 });
    // The button shows only to the bot's own person.
    learn(alicesWriter.id, "own-thing");
    const listed = skills.listSkills(alicesWriter.id);
    expect(withAllBotsOffer(alicesWriter as never, session("alice@acme.test"), listed).filter((skill) => skill.canUseOnAllBots).map((skill) => skill.name)).toEqual(["own-thing"]);
    expect(withAllBotsOffer(alicesWriter as never, session("bob@acme.test"), listed).some((skill) => skill.canUseOnAllBots)).toBe(false);
  });

  it("on a server several people share without a team: none, and the tool and the page say why", async () => {
    sharedWithoutTeam = true;
    const chief = bot("Chief");
    expect(everywhere.allBotsScopeOfBot(chief)).toBeNull();
    expect(requesterScope(chief as never, { kind: "loopback", scopes: ["admin"] } as never)).toEqual({ status: 409, error: everywhere.SHARED_WITHOUT_TEAM });
    const { call } = host(true);
    expect(await call(chief, { action: "create", all_bots: true, skill_md: SKILL("x-skill"), source: "conversation" })).toEqual({ status: 422, body: { error: everywhere.SHARED_WITHOUT_TEAM } });
  });
});

const dataDirs: string[] = [];
afterEach(async () => {
  for (const dir of dataDirs.splice(0)) await flushDecisionLog(dir);
});
function host(direct: boolean, room = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-all-bots-host-"));
  dataDirs.push(dataDir);
  const messages: Array<{ id: string; threadId: string; card: any }> = [];
  const made = createSkillsForAllBotsHost({
    store: {
      bot: (id: string) => bots.find((one) => one.id === id) as never,
      appendMessage: ((threadId: string, message: { card: unknown }) => { messages.push({ id: `m${messages.length}`, threadId, card: message.card }); }) as never,
      patchMessage: ((_thread: string, id: string, patch: { card: unknown }) => { messages.find((one) => one.id === id)!.card = patch.card; }) as never,
      groupByThread: (() => (room ? { id: "room" } : undefined)) as never,
    },
    dataDir,
    persistence: () => ({ ok: true }),
    noteSkillChange: vi.fn(),
  });
  const call = (from: Bot, body: Record<string, unknown>, actsFor: string | null = null) =>
    made.stage(from as never, "t1", body, () => (direct ? "full-access" : null), async (asked) => asked, () => true, () => actsFor);
  const last = () => messages.at(-1)!;
  const undo = (from: Bot) => made.undo(from.id, last().threadId, last() as never, last().card.skillRequest);
  const answer = (from: Bot, behavior: "allow" | "deny") =>
    made.resolve({ botId: from.id, threadId: "t1", requestId: last().card.requestId, behavior, reviewedSha256: last().card.skillRequest.sha256 }, last().id, last().card, last().card.skillRequest);
  return { made, call, last, undo, answer, messages };
}

describe("changing them through skill_manage and the Skills page", () => {
  it("creates on every bot in one call with a receipt, and Undo gives each bot back what it had", async () => {
    const chief = bot("Chief"), writer = bot("Writer"), quiet = bot("Quiet");
    learn(quiet.id, "client-onboarding");
    skills.setSkillEnabled(quiet.id, "client-onboarding", false);
    const { call, last, undo } = host(true);
    const result = await call(chief, { action: "create", all_bots: true, skill_md: SKILL("client-onboarding"), source: "conversation" });
    expect(result).toMatchObject({ status: 201, body: { state: "applied", allBots: true, name: "client-onboarding" } });
    expect(last().card).toMatchObject({ autoApplied: true, title: 'Skill "client-onboarding" is on all your bots', skillRequest: { allBots: true, action: "create" } });
    expect([on(chief.id), on(writer.id), on(quiet.id)]).toEqual([["client-onboarding"], ["client-onboarding"], []]);
    expect(shared(quiet.id)).toEqual(["client-onboarding"]);

    expect(undo(chief)).toEqual({ claimed: true, state: "undone" });
    expect([skills.listSkills(chief.id), skills.listSkills(writer.id)]).toEqual([[], []]);
    expect(skills.listSkills(quiet.id).map((skill) => [skill.name, skill.enabled, Boolean(skill.allBots)])).toEqual([["client-onboarding", false, false]]);
  });

  it("updates and deletes a shared skill by its name alone; Undo of a delete brings back each bot's switch", async () => {
    const chief = bot("Chief"), writer = bot("Writer");
    const { call, undo } = host(true);
    const references = [{ path: "references/steps.md", content: "# Steps\n\nOne, two.\n" }, { path: "references/tone.md", content: "# Tone\n\nPlain.\n" }];
    await call(chief, { action: "create", all_bots: true, skill_md: SKILL("weekly-report"), references, source: "conversation" });
    const updated = await call(writer, { action: "update", skill_name: "weekly-report", skill_md: SKILL("weekly-report", "New way."), source: "conversation" });
    expect(updated).toMatchObject({ status: 201, body: { state: "applied", action: "update" } });
    expect(ops.sharedCopy("mine", "weekly-report")?.files.map((file) => file.path)).toEqual(["references/steps.md", "references/tone.md"]);
    expect(skills.readSkillFile(chief.id, "weekly-report")).toContain("New way.");
    await call(chief, { action: "update", skill_name: "weekly-report", skill_md: SKILL("weekly-report", "Newer."), references: [{ path: "references/tone.md", content: "" }], source: "conversation" });
    expect(ops.sharedCopy("mine", "weekly-report")?.files.map((file) => file.path)).toEqual(["references/steps.md"]);
    expect(undo(chief)).toEqual({ claimed: true, state: "undone" });
    expect(skills.readSkillFile(writer.id, "weekly-report")).toContain("New way.");

    skills.setSkillEnabled(writer.id, "weekly-report", false);
    expect(await call(chief, { action: "delete", skill_name: "weekly-report" })).toMatchObject({ status: 201, body: { state: "applied", action: "delete" } });
    expect([skills.listSkills(chief.id), skills.listSkills(writer.id)]).toEqual([[], []]);
    expect(undo(chief)).toEqual({ claimed: true, state: "undone" });
    expect([on(chief.id), on(writer.id), shared(writer.id)]).toEqual([["weekly-report"], [], ["weekly-report"]]);
  });

  it("names the bots Undo could not put back, and puts back the rest", async () => {
    const chief = bot("Chief"), writer = bot("Writer");
    const { call, undo } = host(true);
    await call(chief, { action: "create", all_bots: true, skill_md: SKILL("tidy-inbox"), source: "conversation" });
    await call(chief, { action: "delete", skill_name: "tidy-inbox" });
    // The writer's skills folder is no folder any more: its copy cannot come back there.
    rmSync(join(workspaceDir(writer.id), "skills"), { recursive: true, force: true });
    writeFileSync(join(workspaceDir(writer.id), "skills"), "not a folder");
    expect(undo(chief)).toMatchObject({ claimed: true, state: "invalid", error: expect.stringContaining("Undone, except on Writer") });
    expect(on(chief.id)).toEqual(["tidy-inbox"]);
  });

  it("waits on a card where the bot's own skill changes would, and in a room whatever the access level", async () => {
    const chief = bot("Chief"), writer = bot("Writer");
    for (const [direct, room] of [[false, false], [true, true]] as const) {
      const name = room ? "in-room" : "invoice-check";
      const { call, last, answer } = host(direct, room);
      expect(await call(chief, { action: "create", all_bots: true, skill_md: SKILL(name), source: "conversation" })).toMatchObject({ status: 201, body: { state: "pending" } });
      expect(last().card).toMatchObject({ options: ["Enable", "Deny"], title: `Put skill "${name}" on all your bots?` });
      expect(on(writer.id)).not.toContain(name);
      expect(answer(chief, "allow")).toEqual({ claimed: true, outcome: "allowed-once" });
      expect(on(writer.id)).toContain(name);
    }
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
    expect(await call(alicesChief, create, personKey({ id: "", email: "bob@acme.test" }))).toMatchObject({ status: 403 });
    expect(await call(alicesChief, create, null)).toMatchObject({ status: 403 });
    expect(skills.listSkills(alicesWriter.id)).toEqual([]);
    expect(await call(alicesChief, create, personKey({ id: "", email: "alice@acme.test" }))).toMatchObject({ status: 201, body: { state: "applied" } });
    expect(shared(alicesWriter.id)).toEqual(["team-thing"]);
  });

  it("the page's Use on all bots posts a receipt in the bot's chat whose Undo gives each bot back what it had", () => {
    const chief = bot("Chief"), writer = bot("Writer"), keeper = bot("Keeper");
    learn(chief.id, "client-onboarding");
    learn(keeper.id, "client-onboarding", "Different.");
    const { made, last, undo } = host(true);
    expect(made.fromSkillsPage(chief as never, "client-onboarding", "mine")).toEqual({ status: 200, body: { name: "client-onboarding", kept: ["Keeper"], failed: [] } });
    expect(last()).toMatchObject({ threadId: chief.threadId, card: { autoApplied: true, skillRequest: { allBots: true, action: "create" } } });
    expect(shared(writer.id)).toEqual(["client-onboarding"]);
    // From the bot that kept a different copy, it is refused rather than replacing the shared one.
    expect(made.fromSkillsPage(keeper as never, "client-onboarding", "mine")).toMatchObject({ status: 409 });
    expect(undo(chief)).toEqual({ claimed: true, state: "undone" });
    expect([on(chief.id), on(writer.id), on(keeper.id)]).toEqual([["client-onboarding"], [], ["client-onboarding"]]);
    expect(skills.readSkillFile(keeper.id, "client-onboarding")).toContain("Different.");
  });
});
