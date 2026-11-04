import assert from "node:assert/strict";
import test from "node:test";

import { gapKey, gapSummary, STAYED_MAX, stayedBehind } from "./move-gaps.mjs";

const report = (extra = {}) => ({
  ok: false,
  gaps: { items: [{ key: "bot:b9", kind: "bot", label: "Archie" }], parts: [], memory: [{ bot: "b1", path: "memory/notes.md" }, { bot: "b1", path: "memory/log/2026-10-03.md" }],
    rooms: [], connections: ["mcp:linear"], conversations: ["t2"], files: ["workspaces/b1/drafts/report.docx"], runs: [], journal: [], learned: [], teams: [], settings: [] },
  chats: [{ threadId: "t1", missing: 3, unstamped: 0, path: "equal" }, { threadId: "t3", missing: 0, unstamped: 0, path: "broken" }, { threadId: "t4", missing: 0, unstamped: 0, path: "inside" }],
  attachments: ["0b6c9f2e-1d4a-4b6e-9f1a-2c3d4e5f6a7b.mp3"],
  secrets: { equal: ["key:openrouter"], differs: [], missing: ["login:example.test|alice"] },
  names: { b1: "Scout", b9: "Archie", "room:r1": "Launch room" },
  owners: { t1: "b1", t2: "b1", t3: "room:r1" },
  ...extra,
});

test("the same gaps give the same key in any order, and anything else missing gives another", () => {
  const one = report();
  const shuffled = report({ gaps: { ...one.gaps, memory: [...one.gaps.memory].reverse() }, chats: [...one.chats].reverse(), names: {}, owners: {} });
  assert.equal(gapKey(one), gapKey(shuffled), "order, names and owners never change the key");
  assert.equal(gapKey(report({ chats: one.chats.filter((entry) => entry.threadId !== "t4") })), gapKey(one), "a chat whose path holds inside a longer one is no gap");
  assert.notEqual(gapKey(report({ attachments: [] })), gapKey(one));
  assert.notEqual(gapKey(report({ chats: [{ threadId: "t1", missing: 2, unstamped: 0, path: "equal" }] })), gapKey(report({ chats: [{ threadId: "t1", missing: 3, unstamped: 0, path: "equal" }] })),
    "a chat that got some of its rows is progress");
  assert.match(gapKey(one), /^[a-f0-9]{24}$/u);
});

test("the Admin hears kinds and counts only: never a name, an id, a path or a credential", () => {
  const said = gapSummary(report());
  assert.equal(said, "1 items, 2 memory, 1 connections, 1 conversations, 1 files, 2 chats (3 rows, 1 broken paths), 1 attachments, 1 credentials missing");
  assert.doesNotMatch(said, /Archie|Scout|linear|report\.docx|alice|example|t1|t3|b1|0b6c9f2e/u);
  assert.equal(gapSummary({}), "something");
});

test("what stayed behind is said in the person's words, one line for each thing they know, by its bot or room", () => {
  assert.deepEqual(stayedBehind(report()), [
    { label: "Archie", error: "It didn't reach My Cloud." },
    { label: "Scout", error: "2 of its memory notes didn't reach My Cloud." },
    { label: "Scout", error: "One of its files didn't reach My Cloud." },
    { label: "Scout", error: "Parts of 2 chats didn't reach My Cloud." },
    { label: "Launch room", error: "Part of one chat didn't reach My Cloud." },
    { label: "linear", error: "It didn't reach My Cloud. Add it there again if a bot needs it." },
    { label: "An attachment", error: "It didn't reach My Cloud." },
    { label: "A sign-in or key", error: "It didn't reach My Cloud. Add it there again if a bot needs it." },
  ]);
  const said = JSON.stringify(stayedBehind(report()));
  assert.doesNotMatch(said, /report\.docx|memory\/|alice|example\.test|0b6c9f2e|"t1"|"b1"/u, "never a path, a file name, an id or an account");
  assert.deepEqual(stayedBehind(report({ names: {}, owners: {} })).slice(1, 3), [
    { label: "A bot", error: "2 of its memory notes didn't reach My Cloud." },
    { label: "A bot", error: "One of its files didn't reach My Cloud." },
  ], "a bot it can't name is still said");
  assert.deepEqual(stayedBehind({ ok: false }), [], "nothing named, nothing left behind");
});

test("at most a handful of lines, the rest counted", () => {
  const items = Array.from({ length: 20 }, (_, at) => ({ key: `bot:b${at}`, kind: "bot", label: `Bot ${at}` }));
  const said = stayedBehind({ ok: false, gaps: { items } });
  assert.equal(said.length, STAYED_MAX);
  assert.deepEqual(said.at(-1), { label: "13 more", error: "They didn't reach My Cloud." });
});
