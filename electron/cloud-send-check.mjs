// What a move to the person's own Cloud checks once it has run, from both servers' own answers and never a secret:
// the two manifests (GET /api/cloud-send/manifest), each conversation's rows, its owner's lines and its visible path
// (this computer's /api/cloud-send/chats/ids against My Cloud's /chats/verify), the attachments the rows name, and each
// credential's fingerprint under a fresh nonce (this computer's private port against My Cloud's /verify-secrets).
import { randomBytes } from "node:crypto";
import { EMPTY } from "./cloud-send-parts.mjs";
import { fileArrived } from "./cloud-send-kinds.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
/** As many of a conversation's row ids, and of its path, as My Cloud checks at once. */
const IDS = 5_000;
/** My Cloud checks at most this many conversations, and row and path ids together, a request. */
const VERIFY_CONVERSATIONS = 200;
const VERIFY_IDS = 2 * IDS;
const ATTACHMENT_NAMES = 2_000;
const THREAD = /^[\w-]{1,200}$/u;

/** The waits between tries of a request nothing answered, and how long a check goes on while none of its requests gets an
 * answer: a slow Cloud that keeps answering is waited for however long its work takes. */
export const PATIENCE_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]);
export const STALL_MS = 10 * 60_000;
/** How often a check that waits for My Cloud looks whether the person stopped the move. */
const STOP_LOOK_MS = 5_000;
/** The waits before a move's pass gives up on a request it can safely ask again: as long as a Cloud takes to start again. */
export const BLIP_MS = Object.freeze([5_000, 15_000, 30_000, 60_000]);

/** Nothing answered on the way to My Cloud (no network, a timeout, a gateway error, the Admin's or My Cloud's), as
 * against a refusal: trying again soon may well work. */
export function unanswered(error, depth = 0) {
  if (!error || depth > 4) return false;
  if ((error.name === "TypeError" && /fetch/iu.test(error.message ?? "")) || error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (Number.isInteger(error.status) && error.status >= 500) return true;
  return unanswered(error.cause, depth + 1);
}

/** An answer of My Cloud's, or the error it is: a gateway error (5xx) stays one that trying again may get past, and any
 * other is what `refuse(answer, message)` makes of it. */
export function answered(answer, message, refuse = null) {
  if (answer.ok) return answer;
  if (refuse && !(answer.status >= 500)) throw refuse(answer, message);
  throw Object.assign(new Error(message), { status: answer.status });
}

const nap = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * A check's patience with a slow Cloud: a request nothing answered is asked again after PATIENCE_MS, for as long as some
 * request got an answer in the last STALL_MS (`moved`). Then it gives up with an error that still reads as unanswered and
 * says whether any of the work got done (`progressed`), which the next check does not do again; an answer that only
 * opens the work (`run(work, { counts: false })`) keeps it waiting without counting as work done. `onWait(until)` while it
 * waits, `onWait(null)` once it asks again. `stopped()`: the person stopped the move, so it ends at the next answer or look.
 */
export function createPatience({ now = Date.now, sleep = nap, onWait = () => {}, stallMs = STALL_MS, waits = PATIENCE_MS, stopped = () => false } = {}) {
  let movedAt = now(), progressed = false, tries = 0;
  const stop = () => { if (stopped()) throw Object.assign(new Error("The move stopped."), { code: "stopped" }); };
  const patience = {
    moved({ counts = true } = {}) { movedAt = now(); tries = 0; if (counts) progressed = true; stop(); },
    get progressed() { return progressed; },
    /** Waits before asking again after `error`, or throws once the check has stood still too long. */
    async wait(error) {
      if (!unanswered(error)) throw error;
      const ms = waits[Math.min(tries++, waits.length - 1)];
      if (now() + ms - movedAt > stallMs) {
        throw Object.assign(new Error(`My Cloud did not answer for ${Math.round((now() - movedAt) / 60_000)} min (${error?.message ?? "no answer"}).`), { cause: error, code: "slow", progressed });
      }
      onWait(now() + ms);
      for (let left = ms; left > 0; left -= STOP_LOOK_MS) { stop(); await sleep(Math.min(left, STOP_LOOK_MS)); }
      stop();
      onWait(null);
    },
    /** `work()` until it is answered. */
    async run(work, { counts = true } = {}) {
      for (;;) {
        try { const value = await work(); patience.moved({ counts }); return value; }
        catch (error) { await patience.wait(error); }
      }
    },
  };
  return patience;
}

const GATEWAY = new Set([502, 503, 504]);
const REPEATABLE = /^\/api\/cloud-send\/chats(?:[/?]|$)/u;

/**
 * A move's session for its passes: a read, or a chats request My Cloud adds by id, is asked again through a blip (BLIP_MS)
 * instead of ending the pass. What still has no answer after that throws as it did, or comes back as the gateway answered,
 * and says whether anything was answered before it (`progressed`).
 */
export function patientSession(session, { sleep = nap, blips = BLIP_MS } = {}) {
  let answeredOnce = false;
  return {
    ...session,
    async call(method, route, body, options) {
      if (method !== "GET" && !REPEATABLE.test(route)) return session.call(method, route, body, options);
      for (let waited = 0; ; waited++) {
        try {
          const answer = await session.call(method, route, body, options);
          if (!GATEWAY.has(answer.status) || waited >= blips.length) {
            if (!GATEWAY.has(answer.status)) answeredOnce = true;
            return answer;
          }
        } catch (error) {
          if (!unanswered(error) || waited >= blips.length) throw Object.assign(error, { progressed: answeredOnce });
        }
        await sleep(blips[waited]);
      }
    },
  };
}

/** Asks once: what a check without patience does. */
const IMPATIENT = { moved() {}, progressed: false, wait: async (error) => { throw error; }, run: (work) => work() };

/** My Cloud's journal shows at most this many of a bot's latest changes. */
const JOURNAL_ROWS = 500;

/** The rooms of `here` that a move carries: those with a bot that goes (`bots`). My Cloud makes a room only once one of
 * its bots is there (server/cloud-chat-merge.ts), so one whose bots were all deleted here, or removed on My Cloud, stays. */
export function roomsThatGo(here, bots) {
  return new Set(list(here?.rooms).filter((room) => record(room) && list(room.members).some((id) => bots.has(id))).map((room) => room.id));
}

/** The rooms of `here` My Cloud had once and lacks now, as `room:<id>`: a conversation of the room went (`chats`, the
 * cursors cloud-send.mjs keeps, "removed" included) and every one of its conversations with rows here did, so nothing
 * here makes it again; My Cloud answers that each was removed there. */
export function roomsRemovedThere(here, there, chats) {
  const held = new Set(list(there?.rooms).map((room) => room.id));
  const went = (threadId) => record(chats) && chats[threadId] !== undefined;
  return list(here?.rooms).filter((room) => record(room) && !held.has(room.id) && list(room.threads).some(went)
    && list(here?.conversations).filter((head) => head.room === room.id).every((head) => went(head.threadId))).map((room) => `room:${room.id}`);
}

/**
 * What of this computer's manifest My Cloud's lacks: items, memory, rooms, connections and conversations it does not
 * have, and parts of items it holds otherwise than it took them; the pieces of a memory note, a team's context or memory,
 * a learned fact, a journal row, a bot file, a routine's finished run or a conversation's own setting it lacks. A part
 * counts as carried when it is equal on both sides, or when, since it last went (`sent`: what each side held then, as
 * cloud-send.mjs keeps it), this computer did not change it or My Cloud did (then My Cloud's is kept).
 * Left out: what was removed on My Cloud (`removed`, by key, `room:<id>` or conversation id), what this computer never
 * sends (`skip`), and a room no bot of which goes, with its conversations (roomsThatGo).
 */
export function manifestGaps(here, there, { sent = {}, removed = new Set(), skip = new Set() } = {}) {
  const gaps = { items: [], parts: [], memory: [], rooms: [], connections: [], conversations: [], files: [], runs: [], journal: [], learned: [], teams: [], settings: [] };
  if (!record(here) || !record(there)) return null;
  const theirs = new Map(list(there.items).map((item) => [item.key, item]));
  const bots = new Set();
  const carried = new Set();
  for (const item of list(here.items)) {
    if (removed.has(item.key) || skip.has(item.key) || (item.bot && (removed.has(`bot:${item.bot}`) || skip.has(`bot:${item.bot}`)))) continue;
    carried.add(item.key);
    if (item.kind === "bot") bots.add(item.id);
    const on = theirs.get(item.key);
    if (!on) { gaps.items.push({ key: item.key, kind: item.kind, label: item.label }); continue; }
    // Logins and 1Password are compared by their secrets' fingerprints, never by when they changed.
    if (item.kind === "login" || item.kind === "1password") continue;
    const differs = Object.entries(item.parts ?? {}).filter(([part, hash]) => {
      const cloud = on.parts?.[part] ?? EMPTY;
      const pair = sent[item.key]?.[part];
      // Missing only when this computer changed it since it last went, and My Cloud did not: that change should have gone.
      return hash !== cloud && !(Array.isArray(pair) && (pair[0] === hash || pair[1] !== cloud));
    }).map(([part]) => part);
    if (differs.length) gaps.parts.push({ key: item.key, label: item.label, parts: differs });
  }
  const notes = new Map(list(there.memory).map((note) => [`${note.bot}/${note.path}`, note]));
  for (const note of list(here.memory)) {
    if (!bots.has(note.bot)) continue;
    const held = notes.get(`${note.bot}/${note.path}`);
    const lines = new Set(list(held?.lines));
    if (!held || (Array.isArray(note.lines) ? note.lines.some((line) => !lines.has(line)) : held.hash !== note.hash)) gaps.memory.push({ bot: note.bot, path: note.path });
  }
  const journals = new Map(list(there.journal).map((entry) => [entry.bot, list(entry.ids)]));
  for (const entry of list(here.journal)) {
    const held = journals.get(entry.bot) ?? [];
    const ids = new Set(held);
    if (bots.has(entry.bot) && held.length < JOURNAL_ROWS && list(entry.ids).some((id) => !ids.has(id))) gaps.journal.push(entry.bot);
  }
  const known = new Set([...list(there.learned), ...list(there.forgotten)]);
  for (const fact of list(here.learned)) if (!known.has(fact)) gaps.learned.push(fact);
  const teams = new Map(list(there.teams).map((team) => [team.section, team]));
  for (const team of list(here.teams)) {
    const held = teams.get(team.section);
    const context = new Set(list(held?.context)), memory = new Set(list(held?.memory));
    if (list(team.context).some((line) => !context.has(line)) || list(team.memory).some((key) => !memory.has(key))) gaps.teams.push(team.section);
  }
  const going = roomsThatGo(here, bots);
  const rooms = new Set(list(there.rooms).map((room) => room.id));
  for (const room of list(here.rooms)) if (going.has(room.id) && !removed.has(`room:${room.id}`) && !rooms.has(room.id)) gaps.rooms.push({ id: room.id, name: room.name });
  const connections = new Set(list(there.connections));
  for (const id of list(here.connections)) if (!skip.has(id) && !connections.has(id)) gaps.connections.push(id);
  const conversations = new Map(list(there.conversations).map((head) => [head.threadId, head]));
  for (const head of list(here.conversations)) {
    if (removed.has(head.threadId) || (head.bot && !bots.has(head.bot)) || (head.room && (!going.has(head.room) || removed.has(`room:${head.room}`)))) continue;
    const held = conversations.get(head.threadId);
    if (!held) { gaps.conversations.push(head.threadId); continue; }
    if (Object.keys(record(head.settings) ? head.settings : {}).some((key) => !record(held.settings) || held.settings[key] === undefined)) gaps.settings.push(head.threadId);
  }
  const files = new Map(list(there.files).map((file) => [file.path, file]));
  for (const file of list(here.files)) {
    const bot = /^(?:workspaces|task-workspaces)\/([\w-]{1,128})\//u.exec(file.path)?.[1];
    if (bots.has(bot) && !fileArrived(file, files)) gaps.files.push(file.path);
  }
  const runs = new Set(list(there.runs).map((run) => run.id));
  for (const run of list(here.runs)) if (carried.has(`routine:${run.routine}`) && !runs.has(run.id)) gaps.runs.push(run.id);
  return gaps;
}

export const noGaps = (gaps) => Boolean(gaps) && Object.values(gaps).every((entries) => entries.length === 0);

/** A conversation's row ids on this computer, and its visible path's, a chunk at a time. */
export async function* rowIdChunks(localJson, threadId) {
  for (let from = 0, more = true; more; from += IDS) {
    const page = await localJson(`/api/cloud-send/chats/ids?thread=${threadId}&from=${from}`);
    if (!record(page)) throw new Error("OpenMausBot on this computer did not list a conversation's rows.");
    more = page.more === true;
    yield { ids: list(page.ids), path: list(page.path), leaf: page.leaf ?? null, more };
  }
}

/**
 * Each conversation's rows and visible path checked on My Cloud, ids only: `missing`, the rows My Cloud lacks;
 * `unstamped`, the lines of its owner's it holds that do not carry the owner yet; `path`: "equal" when My Cloud shows
 * exactly this computer's path, "inside" when this computer's path appears in order inside a longer one of My Cloud's
 * (both sides added to it), "broken" otherwise. Conversations of up to IDS rows go many to a request; a longer one goes a
 * chunk at a time, each after the one before it, as its path is checked in order. A request nothing answered is split in
 * two, and the rest of the check asks for less at a time, until one conversation's chunk waits for My Cloud (`patience`).
 * `skip(threadId)`: checked before and unchanged since, left out; `checked(threadId)`: nothing missing; `onProgress(done,
 * total)` as conversations are checked.
 */
export async function checkChats({ localJson, session, threads, skip = () => false, checked = () => {}, onProgress = () => {}, patience = IMPATIENT, timeoutMs }) {
  const out = [];
  const todo = threads.filter((id) => THREAD.test(id));
  const total = todo.length;
  let done = 0, most = VERIFY_CONVERSATIONS, budget = VERIFY_IDS, batch = [], ids = 0;
  const verify = async (conversations) => {
    const answer = answered(await session.call("POST", "/api/cloud-send/chats/verify", { v: 1, conversations }, timeoutMs ? { timeoutMs } : undefined), "My Cloud did not check the chats.");
    const byThread = new Map(list(answer.body?.conversations).filter(record).map((entry) => [entry.threadId, entry]));
    if (conversations.some((entry) => !byThread.has(entry.threadId))) throw Object.assign(new Error("My Cloud did not check the chats."), { status: answer.status });
    return byThread;
  };
  const finish = (result) => {
    out.push(result);
    if (!result.missing && !result.unstamped && result.path !== "broken") checked(result.threadId);
    onProgress(++done, total);
  };
  const flush = async () => {
    const queue = batch.length ? [batch] : [];
    batch = []; ids = 0;
    while (queue.length) {
      const part = queue.shift();
      let answers;
      try { answers = await verify(part.map(({ asked }) => asked)); }
      catch (error) {
        if (!unanswered(error)) throw error;
        if (part.length > 1) {
          const half = Math.ceil(part.length / 2);
          most = Math.max(1, Math.min(most, half));
          budget = Math.max(IDS, Math.floor(budget / 2));
          queue.unshift(part.slice(0, half), part.slice(half));
        } else {
          await patience.wait(error);
          queue.unshift(part);
        }
        continue;
      }
      patience.moved();
      for (const { asked, leaf } of part) {
        const answer = answers.get(asked.threadId);
        const holds = answer.path?.holds === true;
        finish({ threadId: asked.threadId, missing: list(answer.missing).length, unstamped: Number.isSafeInteger(answer.unstamped) ? answer.unstamped : 0,
          path: !holds ? "broken" : answer.path.leaf === leaf && answer.path.length === asked.path.ids.length ? "equal" : "inside" });
      }
    }
  };
  for (const threadId of todo) {
    if (skip(threadId)) { onProgress(++done, total); continue; }
    const first = await localJson(`/api/cloud-send/chats/ids?thread=${threadId}&from=0`);
    if (!record(first)) throw new Error("OpenMausBot on this computer did not list a conversation's rows.");
    if (first.more === true) { finish(await checkLong(threadId)); continue; }
    const asked = { threadId, ids: list(first.ids), path: { after: null, ids: list(first.path), last: true } };
    const size = asked.ids.length + asked.path.ids.length;
    if (batch.length && (batch.length >= most || ids + size > budget)) await flush();
    batch.push({ asked, leaf: first.leaf ?? null });
    ids += size;
  }
  await flush();
  return out;

  async function checkLong(threadId) {
    let missing = 0, unstamped = 0, after = null, holds = true, cloud = null, localLeaf = null, length = 0;
    for await (const chunk of rowIdChunks(localJson, threadId)) {
      localLeaf = chunk.leaf ?? localLeaf;
      length += chunk.path.length;
      const asked = { threadId, ids: chunk.ids, ...(holds ? { path: { after, ids: chunk.path, last: !chunk.more } } : {}) };
      const answer = await patience.run(() => verify([asked])).then((answers) => answers.get(threadId));
      missing += list(answer.missing).length;
      unstamped += Number.isSafeInteger(answer.unstamped) ? answer.unstamped : 0;
      if (asked.path) {
        holds = answer.path?.holds === true;
        after = answer.path?.at ?? null;
        if (!chunk.more) cloud = answer.path;
      }
    }
    return { threadId, missing, unstamped, path: !holds ? "broken" : cloud && cloud.leaf === localLeaf && cloud.length === length ? "equal" : "inside" };
  }
}

/** A move's check passes when nothing is missing: no gap, every conversation's rows there on a path that holds with
 * each line of the owner's carrying them, and every attachment and credential there as it is here. */
export const checkPassed = ({ gaps, chats, attachments, secrets }) => noGaps(gaps)
  && chats.every((thread) => !thread.missing && !thread.unstamped && thread.path !== "broken")
  && !attachments.length && !secrets.differs.length && !secrets.missing.length;

/** The attachments of `names` My Cloud lacks; `onProgress(done, total)` as they are checked. */
export async function missingAttachments(session, names, { patience = IMPATIENT, onProgress = () => {} } = {}) {
  const missing = [];
  for (let i = 0; i < names.length; i += ATTACHMENT_NAMES) {
    const asked = names.slice(i, i + ATTACHMENT_NAMES);
    const answer = await patience.run(async () => answered(await session.call("POST", "/api/cloud-send/chats/attachments", { names: asked }), "My Cloud did not check the attachments."));
    if (!Array.isArray(answer.body?.missing)) throw new Error("My Cloud did not check the attachments.");
    const named = new Set(asked);
    missing.push(...answer.body.missing.filter((name) => named.has(name)));
    onProgress(Math.min(names.length, i + ATTACHMENT_NAMES), names.length);
  }
  return missing;
}

/** Each of this computer's credentials, by id, as `equal`, `differs` (My Cloud holds another value) or `missing` there:
 * their fingerprints under one fresh nonce on both sides, so nothing secret travels. */
export async function checkSecrets({ handoff, session, skip = new Set(), nonce = randomBytes(32).toString("base64url") }) {
  const here = (await handoff({ kind: "verify-secrets", nonce }))?.secrets;
  const answer = await session.call("POST", "/api/cloud-send/verify-secrets", { nonce });
  const there = answer.ok ? answer.body?.secrets : null;
  if (!record(here) || !record(there)) throw Object.assign(new Error("The credentials could not be checked."), { status: answer.status });
  const out = { equal: [], differs: [], missing: [] };
  for (const [id, value] of Object.entries(here)) {
    if (skip.has(id)) continue;
    out[typeof there[id] !== "string" ? "missing" : there[id] === value ? "equal" : "differs"].push(id);
  }
  return out;
}

/** How long a request that lists much may take: My Cloud's, a little longer for each conversation it heads or byte of a
 * bot's files it may hash; this computer's own, frozen while the check reads it. */
const LISTING_MS = 2 * 60_000;
const LISTING_MAX_MS = 30 * 60_000;
export const LOCAL_LISTING_MS = 10 * 60_000;
const listingMs = (work) => Math.min(LISTING_MAX_MS, LISTING_MS + Math.round(work));
const BOT_FILE = /^(?:workspaces|task-workspaces)\/([\w-]{1,128})\//u;

/**
 * What did not arrive of what a move carried, from both sides' own answers: `gaps`, the manifests compared; `chats`, each
 * conversation's rows, its owner's lines and its visible path; `attachments`, the stored ones My Cloud lacks; `secrets`,
 * each credential by its fingerprint (none without `handoff`, as for a bot moving into a team). Left out: what was removed
 * on My Cloud, and a 1Password token 1Password itself refused. `ok` when nothing is missing.
 *
 * Every request is a bounded piece of the work, so a Cloud with thousands of conversations answers each in time: My
 * Cloud's manifest without the attachments and files it never needs to list for this, its files a bot at a time, the
 * chats many conversations to a request. A conversation found whole before (`kept.verified`), with its rows and the path
 * it shows unchanged on both sides since, is not asked about again, so a check cut short goes on where it was. A slow Cloud is waited for while it keeps
 * answering (createPatience). `onStep({ step, done, total, bots, until? })`: which step it is at, how far, and until when
 * it waits for My Cloud. `refuse(answer, message)`: the error a refusal of My Cloud's is.
 */
export async function moveCheck({ session, kept, persist, localJson, handoff, scoped = (route) => route, now = Date.now, sleep, patience: pace = {}, stopped, takesMove, refuse = null, onStep = () => {} }) {
  let bots = 0, at = null;
  const step = (name, done = 0, total = 0) => { at = { step: name, done, total, bots }; onStep(at); };
  const patience = createPatience({ now, ...(sleep ? { sleep } : {}), ...(pace.stallMs !== undefined ? { stallMs: pace.stallMs } : {}), ...(pace.waits ? { waits: pace.waits } : {}), ...(stopped ? { stopped } : {}), onWait: (until) => {
    if (!at) return;
    const { until: _, ...rest } = at;
    at = until ? { ...rest, until } : rest;
    onStep(at);
  } });
  const ask = (method, route, timeoutMs, message = "My Cloud did not answer. Try again.", counts = true) =>
    patience.run(async () => answered(await session.call(method, route, undefined, { timeoutMs }), message, refuse), { counts });
  step("manifest");
  await patience.run(takesMove, { counts: false });
  const here = await localJson(scoped("/api/cloud-send/manifest"), { timeoutMs: LOCAL_LISTING_MS });
  const heads = new Map(list(here?.conversations).filter(record).map((head) => [head.threadId, head]));
  const there = (await ask("GET", scoped("/api/cloud-send/manifest?attachments=0&files=0"), listingMs(heads.size * 20 + list(here?.items).length * 300), undefined, false)).body;
  if (!record(here) || !record(there)) throw new Error("My Cloud did not say what it has. Try again.");
  const removed = new Set([...Object.entries(kept.off).filter(([, why]) => why === "removed").map(([key]) => key),
    ...Object.entries(kept.chats).filter(([, cursor]) => cursor === "removed").map(([threadId]) => threadId),
    ...roomsRemovedThere(here, there, kept.chats)]);
  const refused = new Set(list(kept.whole?.result.failed).filter((failure) => failure.final === true).map((failure) => failure.key));
  const going = new Set(list(here.items).filter((item) => item.kind === "bot" && !removed.has(item.key) && !refused.has(item.key)).map((item) => item.id));
  bots = going.size;
  if (!Array.isArray(there.files)) there.files = await cloudFiles(list(here.files), going, ask, step, scoped);
  const gaps = manifestGaps(here, there, { sent: kept.sent, removed, skip: refused });
  const rooms = roomsThatGo(here, going);
  const threads = list(here.conversations).filter((head) => !removed.has(head.threadId)
    && (head.room ? rooms.has(head.room) && !removed.has(`room:${head.room}`) : going.has(head.bot))).map((head) => head.threadId);
  const theirs = new Map(list(there.conversations).filter(record).map((head) => [head.threadId, head]));
  const theirRows = (threadId) => (Number.isSafeInteger(theirs.get(threadId)?.rows) ? theirs.get(threadId).rows : 0);
  const whole = (threadId) => {
    const seen = kept.verified?.[threadId], head = heads.get(threadId);
    return Boolean(seen && head && seen.newest === head.newest && seen.rows === head.rows && seen.leaf === head.leaf && theirs.has(threadId) && theirRows(threadId) >= seen.there && seen.theirLeaf === theirs.get(threadId).leaf);
  };
  step("chats", 0, threads.length);
  const chats = await checkChats({ localJson, session, threads, patience, timeoutMs: LISTING_MS, skip: whole,
    checked: (threadId) => {
      const head = heads.get(threadId);
      if (kept.verified && head && typeof head.newest === "string" && Number.isSafeInteger(head.rows)) {
        kept.verified[threadId] = { newest: head.newest, rows: head.rows, there: theirRows(threadId), ...(head.leaf ? { leaf: head.leaf } : {}), ...(theirs.get(threadId)?.leaf ? { theirLeaf: theirs.get(threadId).leaf } : {}) };
      }
    },
    onProgress: (done, total) => { if (done % 50 === 0) persist(); step("chats", done, total); } });
  for (const entry of chats) if (entry.unstamped && kept.stamped) delete kept.stamped[entry.threadId];
  persist();
  const names = list(here.attachments);
  step("attachments", 0, names.length);
  const attachments = await missingAttachments(session, names, { patience, onProgress: (done, total) => step("attachments", done, total) });
  step("credentials");
  const secrets = handoff ? await patience.run(() => checkSecrets({ handoff, session, skip: new Set([...removed, ...refused]) }), { counts: false }) : { equal: [], differs: [], missing: [] };
  const ok = checkPassed({ gaps, chats, attachments, secrets });
  // What the person knows things by, for what stayed behind (move-gaps.mjs): bots and rooms by name, and the bot or room
  // each conversation the check found short belongs to.
  const short = new Set([...gaps.conversations, ...gaps.settings, ...chats.filter((entry) => entry.missing || entry.unstamped || entry.path === "broken").map((entry) => entry.threadId)]);
  const named = ok ? {} : Object.fromEntries([...list(here.items).filter((item) => item.kind === "bot" && item.id).map((item) => [item.id, item.label]),
    ...list(here.rooms).map((room) => [`room:${room.id}`, room.name])]);
  const owners = ok ? {} : Object.fromEntries(list(here.conversations).filter((head) => short.has(head.threadId)).map((head) => [head.threadId, head.bot ?? `room:${head.room}`]));
  return { ok, gaps, chats, attachments, secrets, names: named, owners };
}

/** My Cloud's files of the bots that go, a bot at a time, each given as long as hashing that bot's files here could take
 * there; only bots with files here are asked about. */
async function cloudFiles(here, going, ask, step, scoped) {
  const bytes = new Map();
  for (const file of here) {
    const bot = BOT_FILE.exec(typeof file?.path === "string" ? file.path : "")?.[1];
    if (bot && going.has(bot)) bytes.set(bot, (bytes.get(bot) ?? 0) + (Number.isSafeInteger(file.size) ? file.size : 0));
  }
  const out = [];
  let done = 0;
  for (const [bot, size] of bytes) {
    step("files", done, bytes.size);
    const route = scoped("/api/cloud-send/files").includes("bot=") ? scoped("/api/cloud-send/files") : `/api/cloud-send/files?bot=${bot}`;
    const listed = await ask("GET", route, listingMs(size / 20_000), "My Cloud did not list its files.");
    out.push(...list(listed.body?.files));
    step("files", ++done, bytes.size);
  }
  return out;
}
