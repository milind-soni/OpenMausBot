// The audience rule in the bot box on a Team Cloud, through the same wiring a turn uses: the Team Cloud host registers
// its scope with the box, a spawn inside a conversation (engine homes) asks the box for its plan, and the plan says what
// that box may write. bubblewrap itself is a stand-in here that records and runs nothing boxed; the plan is what a real
// one is given (team-box-scope.linux.test.ts runs it in a real box where one can run).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { botBox, type WrappedSpawn } from "../bot-box/box.ts";
import { visibleInBox, type BoxRequest } from "../bot-box/plan.ts";
import { DATA_DIR } from "../config.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";
import { boxAudienceKey, boxedSpawn, sharedBoxScope } from "../procs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ensureTaskWorkspace } from "../workspace.ts";
import { createCloudTeamHost } from "./cloud-team-host.ts";
import { botConversations, createTeamBoxScope } from "./team-box-scope.ts";

const BOT = "bot-scout";
const bots = [{ id: BOT, threadId: "main", tasks: [{ threadId: "mira-1" }, { threadId: "mira-2" }, { threadId: "ben-1" }, { threadId: "team-1" }] }];
const starters = new Map([["mira-1", "p_mira"], ["mira-2", "p_mira"], ["ben-1", "p_ben"], ["team-1", "nobody"], ["main", "nobody"], ["mira-new", "p_mira"]]);
const store = { groupByThread: (threadId: string) => (threadId === "room-1" ? { id: "g1" } : undefined), bots };
const team = (box: { scopeAudiences: typeof botBox.scopeAudiences } | undefined, on = true) => createCloudTeamHost({
  team: on ? { id: "team-acme", name: "Acme" } as never : null, dataDir: DATA_DIR, store, starters, markers: new Set(["nobody"]), engineHomes, ...(box ? { box } : {}),
});

describe("the Team Cloud's box scope", () => {
  const scope = createTeamBoxScope({ audienceOf: (threadId) => team(undefined).audienceOf(threadId), bots: () => bots });

  it("keeps the team's folder read-only for every turn that is not the team's", () => {
    expect(scope({ threadId: "main", botId: BOT, sharedProcess: false })).toEqual({ teamReadOnly: false });
    expect(scope({ threadId: "team-1", botId: BOT, sharedProcess: false })).toEqual({ teamReadOnly: false });
    expect(scope({ threadId: "mira-1", botId: BOT, sharedProcess: false })).toEqual({ teamReadOnly: true });
    expect(scope({ threadId: "room-1", botId: null, sharedProcess: false })).toEqual({ teamReadOnly: true });
  });

  it("gives a shared process its own audience's conversations, the team's read-only, and never another person's", () => {
    expect(scope({ threadId: "mira-1", botId: BOT, sharedProcess: true })?.threads).toEqual({ rw: ["mira-1", "mira-2"], ro: ["main", "team-1"] });
    expect(scope({ threadId: "team-1", botId: BOT, sharedProcess: true })?.threads).toEqual({ rw: ["main", "team-1"], ro: [] });
    expect(scope({ threadId: "ben-1", botId: BOT, sharedProcess: true })?.threads).toEqual({ rw: ["ben-1"], ro: ["main", "team-1"] });
    expect(scope({ threadId: "mira-new", botId: BOT, sharedProcess: true })?.threads, "a conversation the store has not listed yet is still its own")
      .toEqual({ rw: ["mira-1", "mira-2", "mira-new"], ro: ["main", "team-1"] });
    expect(botConversations(bots, "bot-gone")).toEqual([]);
  });

  it("gives every turn the team's shared folder as the host says, whatever its audience", () => {
    const withFiles = createTeamBoxScope({ audienceOf: (threadId) => team(undefined).audienceOf(threadId), bots: () => bots,
      teamFiles: (botId) => ({ source: "/data/team-files", write: botId === BOT }) });
    expect(withFiles({ threadId: "mira-1", botId: BOT, sharedProcess: false })).toEqual({ teamReadOnly: true, teamFiles: { source: "/data/team-files", write: true } });
    expect(withFiles({ threadId: "main", botId: "bot-other", sharedProcess: false })).toEqual({ teamReadOnly: false, teamFiles: { source: "/data/team-files", write: false } });
  });
});

// The box's gates listen on unix sockets, which Windows refuses at a file path; the box runs only on a Linux Cloud home.
describe.skipIf(process.platform === "win32")("a Team Cloud turn's box, through the spawn path", () => {
  let scratch = "";
  const plans: WrappedSpawn[] = [];
  const folder = (threadId: string) => ensureTaskWorkspace(BOT, threadId);
  const at = (path: string) => join(DATA_DIR, path);
  /** The plan a spawn of the bot's engine gets in this conversation, in `cwd`. */
  const planIn = (threadId: string, cwd: string, more: Partial<BoxRequest> = {}) => engineHomes.within(threadId, () => {
    const wrapped = boxedSpawn({ command: "/usr/local/bin/claude", args: [] }, { cwd, env: { HOME: homedir() }, box: more }, "bot");
    expect(wrapped).not.toBeNull();
    plans.push(wrapped!);
    return wrapped!.plan;
  });

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-team-box-scope-"));
    const fakeBwrap = join(scratch, "fake-bwrap.sh");
    writeFileSync(fakeBwrap, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBwrap, 0o755);
    await botBox.start({
      dataDir: DATA_DIR, home: homedir(), port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: fakeBwrap, socat: "/usr/bin/true" } }),
    });
    for (const threadId of ["mira-1", "mira-2", "ben-1", "team-1"]) writeFileSync(join(folder(threadId), "notes.md"), `${threadId}'s notes`);
  });
  afterAll(async () => {
    for (const wrapped of plans) wrapped.release();
    vi.restoreAllMocks();
    botBox.scopeAudiences(null);
    engineHomes.stop();
    await botBox.stop();
    await removeTempDir(scratch);
  });

  it("Mira's private chat reads the team's notes and writes only her own; Ben's chat is not there", () => {
    const host = team(botBox);
    botBox.lend(BOT, "mira-1", host.layerDirs(BOT, "mira-1"));
    const plan = planIn("mira-1", folder("mira-1"));
    for (const file of ["MEMORY.md", "memory/x.md", "skills/report/SKILL.md"]) expect(visibleInBox(plan, at(`workspaces/${BOT}/${file}`)), file).toBe("ro");
    expect(visibleInBox(plan, join(host.layerDirs(BOT, "mira-1")[0]!, "MEMORY.md")), "her own layer").toBe("rw");
    expect(visibleInBox(plan, join(folder("mira-1"), "draft.md"))).toBe("rw");
    expect(visibleInBox(plan, join(folder("ben-1"), "notes.md"))).toBe("none");
    expect(visibleInBox(plan, at(`workspaces/${BOT}--member-p_ben/MEMORY.md`))).toBe("none");
  });

  it("the team's chat still writes the team's notes and skills", () => {
    team(botBox);
    const plan = planIn("team-1", folder("team-1"));
    for (const file of ["MEMORY.md", "skills/report/SKILL.md"]) expect(visibleInBox(plan, at(`workspaces/${BOT}/${file}`)), file).toBe("rw");
    expect(visibleInBox(plan, join(folder("mira-1"), "notes.md"))).toBe("none");
  });

  it("a room's turn in the bot's own folder makes files there and writes its own layer, never the team's notes", () => {
    const host = team(botBox);
    const own = at(`workspaces/${BOT}`);
    mkdirSync(own, { recursive: true });
    rmSync(join(own, "skills"), { recursive: true, force: true });
    botBox.lend(BOT, "room-1", host.layerDirs(BOT, "room-1"));
    const plan = planIn("room-1", own);
    expect(existsSync(join(own, "skills")), "made first, so the read-only bind has something to cover").toBe(true);
    expect(visibleInBox(plan, join(own, "report.md"))).toBe("rw");
    expect(visibleInBox(plan, join(own, "MEMORY.md"))).toBe("ro");
    expect(visibleInBox(plan, join(own, "skills", "x", "SKILL.md"))).toBe("ro");
    expect(visibleInBox(plan, at(`workspaces/${BOT}--room-g1/MEMORY.md`)), "the room's layer, lent to its boxes").toBe("rw");
  });

  it("a process Mira's conversations share has hers and the team's, read-only, and gets a new key for a new conversation", () => {
    team(botBox);
    const plan = planIn("mira-1", folder("mira-1"), { botThreads: true });
    expect(visibleInBox(plan, join(folder("mira-2"), "notes.md"))).toBe("rw");
    expect(visibleInBox(plan, join(folder("team-1"), "notes.md"))).toBe("ro");
    expect(visibleInBox(plan, join(folder("ben-1"), "notes.md"))).toBe("none");
    expect(visibleInBox(plan, at(`workspaces/${BOT}/MEMORY.md`))).toBe("ro");
    const key = (threadId: string) => engineHomes.within(threadId, () => sharedBoxScope(folder(threadId)));
    const mira = key("mira-1");
    expect(mira).not.toBe(key("team-1"));
    bots[0]!.tasks.push({ threadId: "mira-3" });
    try {
      expect(key("mira-1"), "a conversation made later gets a process whose box has its folder").not.toBe(mira);
    } finally {
      bots[0]!.tasks.pop();
    }
  });

  it("a process kept between turns starts again when the bot may no longer edit team files", () => {
    let edit = true;
    createCloudTeamHost({ team: { id: "team-acme", name: "Acme" } as never, dataDir: DATA_DIR, store, starters, markers: new Set(["nobody"]), engineHomes, box: botBox,
      teamFiles: () => ({ source: at("team-files"), write: edit }) });
    const key = () => engineHomes.within("mira-1", () => boxAudienceKey(folder("mira-1")), BOT);
    const before = key();
    expect(visibleInBox(planIn("mira-1", folder("mira-1")), "/team-files/payroll.csv")).toBe("rw");
    edit = false;
    expect(key(), "Claude Code's and the ACP engines' process keys carry it").not.toBe(before);
    expect(visibleInBox(planIn("mira-1", folder("mira-1")), "/team-files/payroll.csv")).toBe("ro");
    expect(engineHomes.within("mira-1", () => sharedBoxScope(folder("mira-1")), BOT)).toContain("#");
  });

  it("off a team the box is as it was: every turn writes the bot's own folder", () => {
    team(botBox, false);
    botBox.scopeAudiences(null);
    engineHomes.stop();
    const plan = planIn("mira-1", folder("mira-1"));
    expect(visibleInBox(plan, at(`workspaces/${BOT}/MEMORY.md`))).toBe("rw");
    expect(visibleInBox(planIn("mira-1", folder("mira-1"), { botThreads: true }), join(folder("ben-1"), "notes.md"))).toBe("rw");
  });
});
