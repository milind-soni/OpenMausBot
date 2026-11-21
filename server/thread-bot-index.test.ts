import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { createThreadBotIndex, scanBotByThread } from "./thread-bot-index.ts";

interface Owner { id: string; threadId: string; tasks?: Array<{ threadId: string }> }

/** A fixed sequence, so a failure repeats. */
function sequence(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state % below;
  };
}

describe("the thread-to-bot index", () => {
  it("answers as the scan does after every one of 4,000 mixed changes made behind its back", () => {
    const next = sequence(7);
    const index = createThreadBotIndex<Owner>();
    let bots: Owner[] = [];
    let made = 0;
    const everSeen: string[] = ["never-a-thread"];
    const thread = () => { const id = `t${made++}`; everSeen.push(id); return id; };
    const bot = (): Owner => { const main = thread(); return { id: `b${made++}`, threadId: main, tasks: [{ threadId: main }, { threadId: thread() }] }; };
    const any = () => bots[next(bots.length)]!;
    const changes: Array<() => void> = [
      () => { bots.unshift(bot()); },
      () => { bots.push(bot()); },
      () => { if (bots.length > 1) bots.splice(next(bots.length), 1); },
      () => { if (bots.length > 1) { const gone = any(); bots = bots.filter((each) => each !== gone); } },
      () => { bots = bots.map((each) => ({ ...each })); },
      () => { if (bots.length) { const at = next(bots.length); bots[at] = { ...bots[at]!, tasks: [...(bots[at]!.tasks ?? [])] }; } },
      () => { if (bots.length) { const at = next(bots.length); bots[at] = bot(); } },
      () => { if (bots.length) { const owner = any(); owner.tasks = [{ threadId: thread() }, ...(owner.tasks ?? [])]; } },
      () => { if (bots.length) any().tasks?.push({ threadId: thread() }); },
      () => { if (bots.length) { const owner = any(); owner.tasks = owner.tasks?.filter((task, at) => at % 2 === 0 || task.threadId === owner.threadId); } },
      () => { if (bots.length) { const owner = any(); if (owner.tasks?.length) owner.threadId = owner.tasks[next(owner.tasks.length)]!.threadId; } },
      () => { if (bots.length) { const owner = any(); const task = owner.tasks?.[0]; if (task) task.threadId = thread(); } },
      () => { if (bots.length) { const owner = any(); owner.threadId = thread(); delete owner.tasks; } },
      () => {
        if (bots.length < 2) return;
        const from = any(), to = any();
        const moved = from.tasks?.pop();
        if (!moved) return;
        if (from === to) { from.tasks!.push(moved); return; }
        to.tasks = [moved, ...(to.tasks ?? [])];
        if (from.threadId === moved.threadId) from.threadId = from.tasks?.[0]?.threadId ?? thread();
      },
      () => { if (bots.length > 1) { const a = next(bots.length), b = next(bots.length); [bots[a], bots[b]] = [bots[b]!, bots[a]!]; } },
      () => { bots.reverse(); },
      () => { if (bots.length) Object.assign(any(), bot(), { id: "reused" }); },
    ];
    const used = new Set<number>();
    let hits = 0;
    for (let step = 0; step < 4_000; step++) {
      const which = next(changes.length);
      used.add(which);
      changes[which]!();
      for (let asked = 0; asked < 12; asked++) {
        const live = bots.flatMap((each) => [each.threadId, ...(each.tasks ?? []).map((task) => task.threadId)]);
        const id = asked % 2 && live.length ? live[next(live.length)]! : everSeen[next(everSeen.length)]!;
        const scanned = scanBotByThread(bots, id);
        expect(index.find(bots, id), `step ${step}, change ${which}, thread ${id}`).toBe(scanned);
        expect(index.find(bots, id), `step ${step}, change ${which}, thread ${id}, asked again`).toBe(scanned);
        if (scanned) hits += 1;
      }
    }
    expect(used.size).toBe(changes.length);
    expect(hits).toBeGreaterThan(20_000);
  });

  it("finds a remembered thread without looking at any other bot's threads", () => {
    let looked = 0;
    const watched = (id: string, threads: string[]): Owner => ({
      id, threadId: threads[0]!,
      get tasks() { looked += 1; return threads.map((threadId) => ({ threadId })); },
    });
    const bots = Array.from({ length: 50 }, (_, at) => watched(`b${at}`, [`t${at}-0`, `t${at}-1`, `t${at}-2`]));
    const index = createThreadBotIndex<Owner>();
    expect(index.find(bots, "t49-2")).toBe(bots[49]);
    expect(looked).toBe(50);
    looked = 0;
    expect(index.find(bots, "t49-2")).toBe(bots[49]);
    expect(looked).toBe(1);
  });
});

describe("Store.botByThread", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("matches a scan of the bots after creating, forking, switching, deleting, reordering and loading from disk", () => {
    let store = new Store(selection);
    const seen = new Set<string>(["no-such-thread"]);
    const agrees = (when: string) => {
      for (const bot of store.bots) for (const id of [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]) seen.add(id);
      for (const group of store.groups) seen.add(group.threadId);
      for (const id of seen) expect(store.botByThread(id), `${when}: ${id}`).toBe(scanBotByThread(store.bots, id));
    };
    const a = store.createBot({ name: "Ada" }), b = store.createBot({ name: "Bo" }), c = store.createBot({ name: "Cy" });
    agrees("three bots");
    const first = store.createTask(a.id, "one")!, second = store.createTask(a.id, "two", false)!;
    const other = store.createTask(b.id, "three")!;
    agrees("new threads");
    expect(store.botByThread(second.threadId)?.id).toBe(a.id);
    store.switchTask(a.id, second.threadId);
    agrees("switched thread");
    const said = store.appendMessage(first.threadId, { role: "user", kind: "text", text: "hello" });
    const fork = store.forkTask(a.id, first.threadId, said.id);
    agrees("forked thread");
    expect(store.botByThread(fork!.threadId)?.id).toBe(a.id);
    store.deleteTask(a.id, first.threadId);
    agrees("deleted thread");
    expect(store.botByThread(first.threadId)).toBeNull();
    store.reorderBots([c.id, a.id, b.id]);
    agrees("reordered bots");
    store.patchBot(b.id, { name: "Bo the second" });
    agrees("patched bot");
    store.createGroup("Room", [a.id, b.id]);
    agrees("a room");
    store.deleteBot(b.id);
    agrees("deleted bot");
    expect(store.botByThread(other.threadId)).toBeNull();
    const d = store.createBot({ name: "Di" });
    agrees("a bot after a delete");
    expect(store.botByThread(d.threadId)?.id).toBe(d.id);
    store = new Store(selection);
    agrees("loaded from disk");
    expect(store.botByThread(second.threadId)?.id).toBe(a.id);
    store.deleteTasks(a.id, [second.threadId]);
    agrees("deleted after loading");
  });
});
