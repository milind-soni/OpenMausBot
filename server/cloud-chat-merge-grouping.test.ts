import { expect, it } from "vitest";
import { applyChatMerge, type ChatMergePlan, type ChatStore } from "./cloud-chat-merge.ts";

it("keeps each owner's incoming order and registers every task before importing rows", () => {
  const bots = [{ id: "a", tasks: [{ threadId: "old-a" }] }, { id: "b", tasks: [] as Array<{ threadId: string }> }];
  const groups = [{ id: "a", tasks: [{ threadId: "old-room" }] }];
  const owners = [{ kind: "bot", id: "a" }, { kind: "group", id: "a" }, { kind: "bot", id: "b" }] as const;
  const plan = { threads: Array.from({ length: 12 }, (_, i) => ({
    owner: owners[i % owners.length], threadId: `thread-${i}`, task: { threadId: `thread-${i}` }, added: [], relinked: [], leaf: null,
  })) } as unknown as ChatMergePlan;
  const original = JSON.stringify(plan), imported: string[] = [], patched: string[] = [];
  const store = {
    bots, groups,
    patchBot(id: string, patch: { tasks: Array<{ threadId: string }> }) { bots.find((bot) => bot.id === id)!.tasks = patch.tasks; patched.push(`bot:${id}`); },
    patchGroup(id: string) { patched.push(`group:${id}`); },
    importTranscript(threadId: string) {
      expect(patched).toEqual(["bot:a", "bot:b", "group:a"]);
      imported.push(threadId);
    },
  } as unknown as ChatStore;

  applyChatMerge(store, plan);
  expect(bots[0]!.tasks.map((task) => task.threadId)).toEqual(["old-a", "thread-0", "thread-3", "thread-6", "thread-9"]);
  expect(bots[1]!.tasks.map((task) => task.threadId)).toEqual(["thread-2", "thread-5", "thread-8", "thread-11"]);
  expect(groups[0]!.tasks.map((task) => task.threadId)).toEqual(["old-room", "thread-1", "thread-4", "thread-7", "thread-10"]);
  expect(imported).toEqual(plan.threads.map((thread) => thread.threadId));
  expect(JSON.stringify(plan)).toBe(original);
});
