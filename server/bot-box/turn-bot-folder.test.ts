// A bot with a configured project folder works in that folder, not in its own one under the data folder. Its turn's box
// must still have the bot's own folder (workspaces/<bot>, where the server saves a request_credential file) and its
// conversation folder (task-workspaces/<bot>/<thread>, handed-off files), and never another bot's. bubblewrap is a
// stand-in that runs nothing; the plan is what a real one is given.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { runInTurn } from "../crash-guard.ts";
import { boxedSpawn, sharedBoxScope } from "../procs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ensureTaskWorkspace, workspaceDir } from "../workspace.ts";
import { botBox, type WrappedSpawn } from "./box.ts";
import { boxUploadsDir, visibleInBox, type BoxRequest } from "./plan.ts";

const BOT = "bot-with-project", OTHER = "bot-other";
const turn = { botId: BOT, threadId: "t1" };

// The box's gates listen on unix sockets, which Windows refuses at a file path; the box runs only on a Linux Cloud home.
describe.skipIf(process.platform === "win32")("a turn's box in a configured project folder", () => {
  let scratch = "", project = "";
  const plans: WrappedSpawn[] = [];
  const spawnIn = (cwd: string | undefined, more: Partial<BoxRequest> = {}) => {
    const wrapped = boxedSpawn({ command: "/usr/local/bin/claude", args: [] }, { ...(cwd ? { cwd } : {}), env: { HOME: homedir() }, box: more }, "bot");
    expect(wrapped).not.toBeNull();
    plans.push(wrapped!);
    return wrapped!.plan;
  };

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-turn-bot-folder-"));
    project = join(scratch, "project");
    mkdirSync(project, { recursive: true });
    for (const bot of [BOT, OTHER]) mkdirSync(workspaceDir(bot), { recursive: true });
    ensureTaskWorkspace(BOT, "t1");
    const fakeBwrap = join(scratch, "fake-bwrap.sh");
    writeFileSync(fakeBwrap, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBwrap, 0o755);
    await botBox.start({
      dataDir: DATA_DIR, home: homedir(), port: 8798, denyEnv: new Set(), env: {}, log: () => {},
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: fakeBwrap, socat: "/usr/bin/true" } }),
    });
  });
  afterAll(async () => {
    for (const wrapped of plans) wrapped.release();
    await botBox.stop();
    await removeTempDir(scratch);
  });

  it("gives the turn's bot its own folder and conversation folder read-write, so a key file saved there is readable", () => {
    const plan = runInTurn(turn, () => spawnIn(project));
    expect(visibleInBox(plan, project)).toBe("rw");
    expect(visibleInBox(plan, join(workspaceDir(BOT), ".openmausbot-secrets", "key.txt"))).toBe("rw");
    expect(visibleInBox(plan, join(ensureTaskWorkspace(BOT, "t1"), "handed.txt"))).toBe("rw");
    expect(plan.botId).toBe(BOT);
  });

  it("does the same for a project folder inside another bot's folder, without the rest of that folder", () => {
    const inOther = join(workspaceDir(OTHER), "grok-import");
    mkdirSync(inOther, { recursive: true });
    const plan = runInTurn(turn, () => spawnIn(inOther));
    expect(visibleInBox(plan, inOther)).toBe("rw");
    expect(visibleInBox(plan, join(workspaceDir(BOT), ".openmausbot-secrets", "key.txt"))).toBe("rw");
    expect(visibleInBox(plan, join(workspaceDir(OTHER), "MEMORY.md"))).toBe("none");
  });

  it("never gives it another bot's folders", () => {
    const plan = runInTurn(turn, () => spawnIn(project));
    expect(visibleInBox(plan, workspaceDir(OTHER))).toBe("none");
    expect(visibleInBox(plan, ensureTaskWorkspace(OTHER, "c1"))).toBe("none");
    expect(visibleInBox(plan, ensureTaskWorkspace(BOT, "t2"))).toBe("none");
  });

  it("keeps a bot the caller names over the turn's", () => {
    const plan = runInTurn(turn, () => spawnIn(project, { botId: OTHER }));
    expect(plan.botId).toBe(OTHER);
    expect(visibleInBox(plan, workspaceDir(BOT))).toBe("none");
    expect(visibleInBox(plan, ensureTaskWorkspace(BOT, "t1"))).toBe("none");
  });

  it("changes nothing for a spawn outside any turn, or with no working folder", () => {
    for (const plan of [spawnIn(project), runInTurn(turn, () => spawnIn(undefined))]) {
      expect(plan.botId).toBeNull();
      expect(visibleInBox(plan, workspaceDir(BOT))).toBe("none");
    }
  });

  it("leaves a conversation folder's box and a bot folder's box as their folder says", () => {
    const conversation = runInTurn(turn, () => spawnIn(ensureTaskWorkspace(OTHER, "c1")));
    expect(conversation.botId).toBe(OTHER);
    expect(visibleInBox(conversation, workspaceDir(BOT))).toBe("none");
    const room = runInTurn(turn, () => spawnIn(workspaceDir(OTHER)));
    expect(room.botId).toBeNull();
    expect(visibleInBox(room, workspaceDir(BOT))).toBe("none");
  });

  it("never lets two bots' turns in one project folder share an engine process", () => {
    const mine = runInTurn(turn, () => sharedBoxScope(project));
    const theirs = runInTurn({ botId: OTHER, threadId: "t2" }, () => sharedBoxScope(project));
    expect(mine).not.toBe(theirs);
    expect(runInTurn({ botId: BOT, threadId: "t3" }, () => sharedBoxScope(project))).toBe(mine);
  });

  it("gives a turn in its bot's own folder (a room's) its own conversation's uploads read-only, and keeps conversations' processes apart", () => {
    const plan = runInTurn(turn, () => spawnIn(workspaceDir(BOT)));
    expect(plan.botId).toBe(BOT);
    expect(visibleInBox(plan, join(boxUploadsDir(DATA_DIR, BOT, "t1"), "notes.md"))).toBe("ro");
    expect(visibleInBox(plan, join(boxUploadsDir(DATA_DIR, BOT, "t2"), "notes.md"))).toBe("none");
    const shared = runInTurn(turn, () => spawnIn(workspaceDir(BOT), { botThreads: true }));
    expect(visibleInBox(shared, join(boxUploadsDir(DATA_DIR, BOT, "t1"), "notes.md"))).toBe("ro");
    expect(visibleInBox(shared, join(boxUploadsDir(DATA_DIR, BOT, "t2"), "notes.md"))).toBe("none");
    const first = runInTurn(turn, () => sharedBoxScope(workspaceDir(BOT)));
    expect(runInTurn({ botId: BOT, threadId: "t2" }, () => sharedBoxScope(workspaceDir(BOT)))).not.toBe(first);
    expect(runInTurn(turn, () => sharedBoxScope(workspaceDir(BOT)))).toBe(first);
  });

  it("keeps the conversation folder out of a process the bot's conversations share", () => {
    const plan = runInTurn(turn, () => spawnIn(project, { botThreads: true }));
    expect(visibleInBox(plan, workspaceDir(BOT))).toBe("rw");
    expect(visibleInBox(plan, ensureTaskWorkspace(BOT, "t1"))).toBe("none");
  });
});
