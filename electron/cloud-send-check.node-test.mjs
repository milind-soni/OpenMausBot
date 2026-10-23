import assert from "node:assert/strict";
import test from "node:test";

import { checkChats, checkPassed, checkSecrets, manifestGaps, missingAttachments, noGaps, roomsRemovedThere, roomsThatGo } from "./cloud-send-check.mjs";

const manifest = (extra = {}) => ({
  v: 1, appVersion: "0.1.120",
  items: [
    { key: "bot:ember", kind: "bot", label: "Ember", id: "ember", parts: { soul: "s1", team: "t1" } },
    { key: "skill:ember:notes", kind: "skill", label: "notes", id: "notes", bot: "ember", parts: { text: "n1", on: "on" } },
    { key: "login:example.test|alice", kind: "login", label: "example.test", parts: { saved: "1" } },
    { key: "bot:juno", kind: "bot", label: "Juno", id: "juno", parts: { soul: "j1" } },
  ],
  memory: [{ bot: "ember", path: "MEMORY.md", hash: "m1" }],
  rooms: [{ id: "r1", name: "Launch", members: ["ember"], threads: ["t-room"] }],
  connections: ["key:openrouter", "mcp:docs"],
  conversations: [{ threadId: "t-ember", bot: "ember", rows: 4, newest: "e4" }, { threadId: "t-juno", bot: "juno", rows: 1, newest: "j1" }, { threadId: "t-room", room: "r1", rows: 2, newest: "r2" }],
  attachments: [],
  ...extra,
});

test("a move's check finds nothing missing when My Cloud holds all this computer sent, its own way of holding a part included", () => {
  const here = manifest();
  const there = manifest({ items: here.items.map((item) => item.key === "bot:ember" ? { ...item, parts: { soul: "s1", team: "t9" } }
    : item.kind === "login" ? { ...item, parts: { saved: "7" } } : item) });
  const sent = { "bot:ember": { team: ["t1", "t9"] } };
  assert.equal(noGaps(manifestGaps(here, there, { sent })), true, "My Cloud's own hash for what it took is in step");
  assert.deepEqual(manifestGaps(here, there).parts, [{ key: "bot:ember", label: "Ember", parts: ["team"] }], "the same part never recorded as taken is not");
});

test("a part changed on both sides since it last went keeps My Cloud's, and so does one only My Cloud changed; one only this computer changed is missing", () => {
  const here = manifest({ items: manifest().items.map((item) => item.key === "bot:ember" ? { ...item, parts: { soul: "s1", team: "t-here" } } : item) });
  const there = manifest({ items: manifest().items.map((item) => item.key === "bot:ember" ? { ...item, parts: { soul: "s1", team: "t-there" } } : item) });
  assert.equal(noGaps(manifestGaps(here, there, { sent: { "bot:ember": { team: ["t-sent", "t-sent"] } } })), true, "changed on both: My Cloud's is kept");
  assert.equal(noGaps(manifestGaps(here, there, { sent: { "bot:ember": { team: ["t-here", "t-sent"] } } })), true, "changed only on My Cloud");
  assert.deepEqual(manifestGaps(here, there, { sent: { "bot:ember": { team: ["t-sent", "t-there"] } } }).parts, [{ key: "bot:ember", label: "Ember", parts: ["team"] }],
    "changed only here, and not on My Cloud: it should have gone");
});

test("a move's check names what My Cloud lacks: items, parts, memory, rooms, connections and conversations, leaving out what was removed there", () => {
  const here = manifest();
  const there = manifest({ items: here.items.filter((item) => item.key !== "skill:ember:notes" && item.key !== "bot:juno").map((item) => item.key === "bot:ember" ? { ...item, parts: { soul: "s2", team: "t1" } } : item),
    memory: [], rooms: [], connections: ["key:openrouter"], conversations: [] });
  assert.deepEqual(manifestGaps(here, there), {
    items: [{ key: "skill:ember:notes", kind: "skill", label: "notes" }, { key: "bot:juno", kind: "bot", label: "Juno" }],
    parts: [{ key: "bot:ember", label: "Ember", parts: ["soul"] }],
    memory: [{ bot: "ember", path: "MEMORY.md" }],
    rooms: [{ id: "r1", name: "Launch" }],
    connections: ["mcp:docs"],
    conversations: ["t-ember", "t-juno", "t-room"],
    files: [], runs: [], journal: [], learned: [], teams: [], settings: [],
  });
  const removed = new Set(["bot:juno", "t-room", "room:r1"]);
  const gaps = manifestGaps(here, there, { removed, skip: new Set(["mcp:docs", "skill:ember:notes"]) });
  assert.deepEqual([gaps.items, gaps.rooms, gaps.connections, gaps.conversations], [[], [], [], ["t-ember"]], "a bot removed there takes its conversations with it");
  assert.equal(manifestGaps(null, there), null);
});

test("a room none of whose bots goes is left out of the check with its conversations, as My Cloud never makes it; one with a bot that goes is not", () => {
  const here = manifest({ rooms: [
    { id: "r1", name: "Launch", members: ["ember"], threads: ["t-room"] },
    { id: "r-orphan", name: "Orphan", members: [], threads: ["t-orphan"] },
    { id: "r-juno", name: "Juno's", members: ["juno"], threads: ["t-juno-room"] },
  ], conversations: [...manifest().conversations, { threadId: "t-orphan", room: "r-orphan", rows: 1, newest: "o1" }, { threadId: "t-juno-room", room: "r-juno", rows: 1, newest: "j9" }] });
  const there = manifest({ rooms: [], conversations: manifest().conversations.filter((head) => !head.room) });
  const gaps = manifestGaps(here, there, { removed: new Set(["bot:juno"]) });
  assert.deepEqual(gaps.rooms, [{ id: "r1", name: "Launch" }], "the bots of Orphan were deleted here, and Juno was removed on My Cloud");
  assert.deepEqual(gaps.conversations, ["t-room"]);
  assert.deepEqual([...roomsThatGo(here, new Set(["ember", "juno"]))], ["r1", "r-juno"]);
});

test("a room My Cloud had once and lacks now counts as removed there, once nothing here would make it again", () => {
  const rooms = [
    { id: "r-gone", name: "Gone", members: ["ember"], threads: ["t-gone", "t-gone-2"] },
    { id: "r-quiet", name: "Quiet", members: ["ember"], threads: ["t-quiet"] },
    { id: "r-new", name: "New", members: ["ember"], threads: ["t-new-1", "t-new-2"] },
    { id: "r-held", name: "Held", members: ["ember"], threads: ["t-held"] },
    { id: "r-never", name: "Never", members: ["ember"], threads: ["t-never"] },
  ];
  const conversations = [{ threadId: "t-gone", room: "r-gone", rows: 2, newest: "g2" }, { threadId: "t-new-1", room: "r-new", rows: 1, newest: "n1" },
    { threadId: "t-new-2", room: "r-new", rows: 1, newest: "n2" }, { threadId: "t-held", room: "r-held", rows: 1, newest: "h1" }, { threadId: "t-never", room: "r-never", rows: 1, newest: "v1" }];
  const here = manifest({ rooms, conversations });
  const there = manifest({ rooms: [{ id: "r-held", name: "Held", members: ["ember"], threads: ["t-held"] }], conversations: [conversations[3]] });
  const chats = { "t-gone": "removed", "t-quiet": { after: 0, id: "" }, "t-new-1": { after: 1, id: "n1" }, "t-held": { after: 1, id: "h1" } };
  const removed = roomsRemovedThere(here, there, chats);
  assert.deepEqual(removed, ["room:r-gone", "room:r-quiet"], "r-new has a conversation that never went, which makes it again; r-held is there; r-never never went");
  const gaps = manifestGaps(here, there, { removed: new Set(removed) });
  assert.deepEqual(gaps.rooms.map((room) => room.id), ["r-new", "r-never"]);
  assert.deepEqual(gaps.conversations, ["t-new-1", "t-new-2", "t-never"], "a room removed there takes its conversations with it");
});

/** This computer's rows and path for `thread`, and a My Cloud that checks them against its own `cloudPath`/`cloudRows`;
 * `unstamped`: the rows it holds of the owner's that do not carry the owner yet. */
function chatsSides({ rows, path, cloudRows = rows, cloudPath = path, unstamped = [] }) {
  const asked = [];
  const localJson = async (route) => {
    const from = Number(/from=(\d+)/u.exec(route)[1]);
    return { v: 1, ids: rows.slice(from, from + 5_000), path: path.slice(from, from + 5_000), leaf: path.at(-1), more: from + 5_000 < Math.max(rows.length, path.length) };
  };
  const session = {
    call: async (_method, _route, body) => {
      asked.push(body.conversations[0]);
      const { threadId, ids, path: chunk } = body.conversations[0];
      let at = chunk?.after ? cloudPath.indexOf(chunk.after) + 1 : 0, holds = true, last = chunk?.after ?? null;
      for (const id of chunk?.ids ?? []) { const found = cloudPath.indexOf(id, at); if (found < 0) { holds = false; break; } at = found + 1; last = id; }
      return { ok: true, status: 200, body: { v: 1, conversations: [{ threadId, missing: ids.filter((id) => !cloudRows.includes(id)), unstamped: ids.filter((id) => unstamped.includes(id)).length,
        ...(chunk ? { path: { holds, at: last, ...(chunk.last ? { leaf: cloudPath.at(-1), length: cloudPath.length } : {}) } } : {}) }] } };
    },
  };
  return { localJson, session, asked };
}

test("each conversation's check says the rows My Cloud lacks and whether its path is equal, inside a longer one, or broken", async () => {
  const ids = (count, prefix = "r") => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  const long = ids(12_001);
  const equal = chatsSides({ rows: long, path: long });
  assert.deepEqual(await checkChats({ localJson: equal.localJson, session: equal.session, threads: ["t-a"] }), [{ threadId: "t-a", missing: 0, unstamped: 0, path: "equal" }]);
  assert.equal(equal.asked.length, 3, "ids and the path go in chunks of 5,000");
  assert.deepEqual(equal.asked.map((chunk) => chunk.path.after), [null, "r4999", "r9999"]);

  const woven = chatsSides({ rows: ids(4), path: ids(4), cloudRows: [...ids(4), "c1"], cloudPath: ["r0", "r1", "c1", "r2", "r3"] });
  assert.deepEqual(await checkChats({ localJson: woven.localJson, session: woven.session, threads: ["t-b"] }), [{ threadId: "t-b", missing: 0, unstamped: 0, path: "inside" }]);

  // As the hidden-chat bug left one: every row there, the first turns off the path My Cloud shows.
  const hidden = chatsSides({ rows: ids(6), path: ids(6), cloudPath: ["r3", "r4", "r5"] });
  assert.deepEqual(await checkChats({ localJson: hidden.localJson, session: hidden.session, threads: ["t-c"] }), [{ threadId: "t-c", missing: 0, unstamped: 0, path: "broken" }]);
  const short = chatsSides({ rows: ids(3), path: ids(3), cloudRows: ["r0"], cloudPath: ["r0"] });
  assert.deepEqual(await checkChats({ localJson: short.localJson, session: short.session, threads: ["t-d"] }), [{ threadId: "t-d", missing: 2, unstamped: 0, path: "broken" }]);
  // Rows My Cloud held before it kept its owner's lines as theirs, counted across chunks.
  const held = chatsSides({ rows: long, path: long, unstamped: ["r3", "r7000"] });
  assert.deepEqual(await checkChats({ localJson: held.localJson, session: held.session, threads: ["t-e"] }), [{ threadId: "t-e", missing: 0, unstamped: 2, path: "equal" }]);
});

test("a move's check passes only when nothing is missing, every path holds, and every line of the owner's carries them", () => {
  const passing = { gaps: { items: [], parts: [], memory: [], rooms: [], connections: [], conversations: [] },
    chats: [{ threadId: "t-a", missing: 0, unstamped: 0, path: "equal" }, { threadId: "t-b", missing: 0, unstamped: 0, path: "inside" }],
    attachments: [], secrets: { equal: ["1password"], differs: [], missing: [] } };
  assert.equal(checkPassed(passing), true);
  for (const [why, failing] of [
    ["a gap", { ...passing, gaps: { ...passing.gaps, memory: [{ bot: "ember", path: "MEMORY.md" }] } }],
    ["a missing row", { ...passing, chats: [{ ...passing.chats[0], missing: 1 }] }],
    ["a line of the owner's that does not carry them", { ...passing, chats: [{ ...passing.chats[0], unstamped: 1 }] }],
    ["a path that does not hold", { ...passing, chats: [{ ...passing.chats[0], path: "broken" }] }],
    ["a missing attachment", { ...passing, attachments: ["00000001.png"] }],
    ["a credential held otherwise", { ...passing, secrets: { ...passing.secrets, differs: ["key:openrouter"] } }],
    ["a missing credential", { ...passing, secrets: { ...passing.secrets, missing: ["mcp:docs"] } }],
  ]) assert.equal(checkPassed(failing), false, why);
});

test("the attachments and credentials My Cloud lacks or holds otherwise are named, by name and id only", async () => {
  const names = Array.from({ length: 2_500 }, (_, i) => `${String(i).padStart(8, "0")}.png`);
  const checked = [];
  const session = {
    call: async (_method, route, body) => {
      if (route === "/api/cloud-send/chats/attachments") { checked.push(body.names.length); return { ok: true, status: 200, body: { missing: body.names.filter((name) => name.startsWith("00000001")) } }; }
      return { ok: true, status: 200, body: { v: 1, secrets: { "login:a|b": `h:${body.nonce}`, "key:openrouter": "other", "mcp:gone": "x" } } };
    },
  };
  assert.deepEqual(await missingAttachments(session, names), names.filter((name) => name.startsWith("00000001")));
  assert.deepEqual(checked, [2_000, 500]);
  const handoff = async (what) => ({ secrets: { "login:a|b": `h:${what.nonce}`, "key:openrouter": "mine", "mcp:docs": "d", "1password": "p" } });
  const secrets = await checkSecrets({ handoff, session, skip: new Set(["1password"]) });
  assert.deepEqual(secrets, { equal: ["login:a|b"], differs: ["key:openrouter"], missing: ["mcp:docs"] });
  await assert.rejects(checkSecrets({ handoff: async () => ({}), session }), /could not be checked/u);
});

test("a move's check finds what only a move carries: memory pieces, journal rows, learned facts, teams, files kept beside, finished runs and conversations' settings", () => {
  const here = manifest({
    items: [...manifest().items, { key: "routine:r1", kind: "routine", label: "Morning", id: "r1", bot: "ember", parts: { def: "d" } }],
    memory: [{ bot: "ember", path: "MEMORY.md", hash: "m1", lines: ["a", "b"] }],
    journal: [{ bot: "ember", ids: ["j1", "j2"] }],
    learned: ["Lives in Pune", "Hates spam"],
    teams: [{ section: "Ops", context: ["c1"], memory: ["person:dana"] }],
    files: [{ path: "workspaces/ember/notes.md", size: 4, sha256: "f1" }, { path: "workspaces/juno/x.md", size: 1, sha256: "f2" }],
    runs: [{ id: "run-1", routine: "r1" }, { id: "run-9", routine: "r-starter" }],
    conversations: manifest().conversations.map((head) => head.threadId === "t-ember" ? { ...head, settings: { snoozedUntil: 5, projectId: "p1" } } : head),
  });
  const there = {
    ...here,
    memory: [{ bot: "ember", path: "MEMORY.md", hash: "other", lines: ["c", "b", "a"] }],
    journal: [{ bot: "ember", ids: ["j9", "j2", "j1"] }],
    learned: ["Lives in Pune"], forgotten: ["Hates spam"],
    teams: [{ section: "Ops", context: ["c0", "c1"], memory: ["person:dana", "term:po"] }],
    files: [{ path: "workspaces/ember/notes.md", size: 5, sha256: "theirs" }, { path: "workspaces/ember/notes (Mac).md", size: 4, sha256: "f1" }],
    runs: [{ id: "run-1", routine: "r1" }],
    conversations: here.conversations.map((head) => head.threadId === "t-ember" ? { ...head, settings: { snoozedUntil: 1, projectId: "p1", approvalMode: "ask" } } : head),
  };
  const removed = new Set(["bot:juno", "t-juno"]);
  assert.equal(noGaps(manifestGaps(here, there, { removed })), true, "merged, kept beside, removed there, or of a routine a move never carried: nothing is missing");
  const gaps = manifestGaps(here, { ...there, memory: [{ bot: "ember", path: "MEMORY.md", hash: "m1", lines: ["a"] }], journal: [{ bot: "ember", ids: ["j1"] }], learned: [], forgotten: [],
    teams: [{ section: "Ops", context: [], memory: [] }], files: [{ path: "workspaces/ember/notes (Mac).md", size: 4, sha256: "other" }], runs: [],
    conversations: here.conversations.map((head) => head.threadId === "t-ember" ? { ...head, settings: { projectId: "p1" } } : head) }, { removed });
  assert.deepEqual({ memory: gaps.memory, journal: gaps.journal, learned: gaps.learned, teams: gaps.teams, files: gaps.files, runs: gaps.runs, settings: gaps.settings }, {
    memory: [{ bot: "ember", path: "MEMORY.md" }], journal: ["ember"], learned: ["Lives in Pune", "Hates spam"], teams: ["Ops"], files: ["workspaces/ember/notes.md"],
    runs: ["run-1"], settings: ["t-ember"],
  });
  const full = { bot: "ember", ids: Array.from({ length: 500 }, (_, i) => `mine-${i}`) };
  assert.deepEqual(manifestGaps(here, { ...there, journal: [full] }, { removed }).journal, [], "a journal showing its latest 500 rows of My Cloud's own may no longer show older ones");
});
