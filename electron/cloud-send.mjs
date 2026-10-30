// Send to My Cloud: this computer's bots, their skills, logins, 1Password, settings and chats go to the person's own
// Cloud. One direction; added and updated, never deleted; one action for every entry point. Chats go by row
// (server/cloud-send-chats.ts): each conversation's rows after the last one My Cloud took, so its history goes once. A
// Cloud too old for that gets Bring newer chats' copy, only from a send the person asked for.
//
// The move ("move") is the same send run to carry everything this computer has: its apps and keys first
// (cloud-connections.mjs), then every bot and its chats whatever was once kept here, over an owner session that counts
// as someone using My Cloud so it stays awake; a sign-in that refreshes itself goes only in the final pass, and this
// computer lets go of its own copy once My Cloud has it. `check` then reads both sides to say what did not arrive
// (cloud-send-check.mjs).
//
// What each side has comes from both servers' GET /api/cloud-send; what goes is decided part by part (planSend in
// cloud-send-parts.mjs) and recorded item by item, so a send cut short goes on from the item it reached. Every write is
// one of My Cloud's own routes, over one owner session per send: the Admin's one-time code for the Cloud it verified,
// redeemed at that Cloud alone, signed out after, as Copy does. A secret reaches main only over the server's private
// port (server/login-handoff.ts) and goes only to that session.
import { createHash } from "node:crypto";
import { AUTOMATION_KINDS, BOT_PARTS, EMPTY, MOVE_BOT_PARTS, MOVE_KINDS, PICTURE_PART, differenceSignature, failedSummary, itemKey, parseSendSummary, pendingRows, planSend, resultKey } from "./cloud-send-parts.mjs";
import { collectConnections, releaseConnections, sendConnections } from "./cloud-connections.mjs";
import { createMoveKinds, mergeRoutines } from "./cloud-send-kinds.mjs";
import { botsOnCloud } from "./cloud-logins.mjs";
import { checkChats, checkPassed, checkSecrets, manifestGaps, missingAttachments, roomsRemovedThere, roomsThatGo, rowIdChunks } from "./cloud-send-check.mjs";

const LOCAL_ROUTE = /^\/api\/(?:cloud-send|cloud-send\?move=1|cloud-send\/manifest|cloud-send\/chats|cloud-send\/chats\?attachments=1|cloud-send\/kind\?key=[\w%.-]{1,300}|cloud-send\/memory|cloud-send\/memory\?bot=[\w-]{1,128}|cloud-send\/files|cloud-send\/files\?path=[\w%.()~!*'-]{1,12000}&offset=\d{1,16}&length=\d{1,9}|cloud-send\/chats\/rows\?thread=[\w-]{1,200}&after=\d{1,16}&id=[\w%.-]{0,600}|cloud-send\/chats\/ids\?thread=[\w-]{1,200}&from=\d{1,9}|cloud-send\/chats\/attachment\/[A-Za-z0-9-]{1,80}\.[A-Za-z0-9]{1,10}|cloud-connections|connectors\/connected|config|bots\?messages=0|bots\/[\w-]{1,128}\/(?:skills|skills\/[a-z0-9-]{1,64}|memory|memory\/file\?path=[\w%.-]{1,200})|attachments\/[A-Za-z0-9-]{1,80}\.(?:png|jpg|gif|webp))$/u;
/** One request's chats: a few conversations' rows, well under My Cloud's body limit. */
const CHATS_BATCH_BYTES = 4 * 1024 * 1024;
const CHATS_BATCH_PAGES = 40;
/** My Cloud checks at most this many attachment names a request. */
const ATTACHMENT_NAMES = 2000;
/** My Cloud takes at most this many row ids, of at most this many conversations, a request. */
const ROW_IDS = 10_000;
const ROW_ID_CONVERSATIONS = 200;
const MEMORY_FILES = 100;
const PICTURE_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const VAULT_ID = /^[\w-]{1,128}$/u;
/** Whole sends, which carry the chats too; a send of some items (Use this computer's, one login) never does. */
const CHAT_REASONS = new Set(["button", "my-cloud", "menu", "move"]);
/** Bring newer chats' copy of the whole workspace, for a Cloud too old to take chats by row: never a move, which such a
 * Cloud refuses. */
const OUTDATED_FOR_MOVE = "My Cloud is updating. Your bots move there by themselves when it's done.";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, 300) : null);

export class CloudSendError extends Error {
  constructor(code, message, options) { super(message, options); this.name = "CloudSendError"; this.code = code; }
}

/** Nothing answered on the way to My Cloud (no network, a timeout, a gateway error, the Admin's or My Cloud's), as
 * against a refusal: trying again soon may well work. */
export function unanswered(error, depth = 0) {
  if (!error || depth > 4) return false;
  if ((error.name === "TypeError" && /fetch/iu.test(error.message ?? "")) || error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (Number.isInteger(error.status) && error.status >= 500) return true;
  return unanswered(error.cause, depth + 1);
}

/** One plain sentence for a failed write, from what My Cloud answered. */
function refusal(answer, fallback) {
  if (answer.status === 401 || answer.status === 403) return "My Cloud did not let this app make the change. Open My Cloud in this app once, then try again.";
  if (answer.status === 409 && /limited to \d+ bots/u.test(answer.body?.error ?? "")) return sentence(answer.body.error);
  return sentence(answer.body?.error) ? `My Cloud said: ${sentence(answer.body.error)}` : fallback;
}

/** My Cloud's own 1Password refusal speaks to someone pasting a token on My Cloud's page; here it was this computer's.
 * 1Password refusing the token is final: sending it again can't help until 1Password is connected again here. */
function onePasswordRefusal(answer) {
  const said = sentence(answer.body?.error);
  if (answer.status === 400 && said && /did not accept the token|not a whole 1Password|service account token/iu.test(said)) {
    return Object.assign(new CloudSendError("refused", "My Cloud's 1Password did not accept this computer's token: it may have been revoked, expired, or lost access to its vault. Connect 1Password again in this computer's Settings → Logins, and it goes to My Cloud by itself."), { final: true });
  }
  return new CloudSendError("refused", refusal(answer, "My Cloud could not connect 1Password."));
}

const pick = (source, names) => Object.fromEntries(names.filter((name) => source[name] !== undefined && source[name] !== null).map((name) => [name, source[name]]));

/** A bot's fields for some parts, as My Cloud's PATCH takes them: nothing that names this computer's other bots unless
 * My Cloud has them, and never Custom approval, which only this computer's own window can grant. */
export function botPatch(bot, parts, cloudBots) {
  const body = {};
  for (const part of parts) {
    const names = BOT_PARTS[part];
    if (names) Object.assign(body, pick(bot, names));
  }
  if (body.approvalMode === "custom") delete body.approvalMode;
  if (Array.isArray(body.peers)) body.peers = body.peers.filter((id) => cloudBots.has(id));
  if (record(body.modelSelection)) body.modelSelection = pick(body.modelSelection, ["instanceId", "model", "effort", "variant"]);
  if (parts.includes("model") && record(body.modelSelection)) body.requireAvailableModel = true;
  return body;
}

const outcomeOf = (value) => record(value) && Number.isSafeInteger(value.at) && record(value.result) ? value : null;
const COUNTED = ["bots", "updatedBots", "skills", "logins", "settings"];
/** What reached My Cloud from this computer, all sends together. */
function countsOf(value) {
  const chats = record(value?.chats) ? value.chats : {};
  const whole = (count) => Number.isSafeInteger(count) && count > 0 ? count : 0;
  return { ...Object.fromEntries(COUNTED.map((key) => [key, whole(value?.[key])])), onePassword: value?.onePassword === true,
    chats: { conversations: whole(chats.conversations), messages: whole(chats.messages) } };
}
const addCounts = (total, sent) => countsOf({ ...Object.fromEntries(COUNTED.map((key) => [key, total[key] + sent[key]])), onePassword: total.onePassword || sent.onePassword,
  chats: { conversations: total.chats.conversations + (sent.chats?.conversations ?? 0), messages: total.chats.messages + (sent.chats?.messages ?? 0) } });

/** The state main keeps in its own folder: per Cloud what was sent, what the person kept here, the bots a send made
 * there whose fields still wait to be recorded (`created`), the bots a send asked My Cloud to make and has not heard back
 * about (`creating`), the sign-ins My Cloud took that this computer still holds
 * (`release`), the bot files a move put there (`files`, path to sha256), and whether each automation a move carried was
 * on here (`on`). */
export function parseSendState(value) {
  const clouds = {};
  if (record(value?.clouds)) {
    for (const [origin, entry] of Object.entries(value.clouds)) {
      if (!/^https?:\/\/[^/\s]+$/u.test(origin) || !record(entry)) continue;
      clouds[origin] = {
        sent: record(entry.sent) ? entry.sent : {},
        off: record(entry.off) ? Object.fromEntries(Object.entries(entry.off).filter(([, why]) => why === "you" || why === "removed")) : {},
        dismissed: typeof entry.dismissed === "string" ? entry.dismissed : "",
        last: outcomeOf(entry.last),
        whole: outcomeOf(entry.whole),
        arrived: countsOf(entry.arrived),
        chats: record(entry.chats) ? Object.fromEntries(Object.entries(entry.chats).filter(([threadId, cursor]) => /^[\w-]{1,200}$/u.test(threadId)
          && (cursor === "removed" || (record(cursor) && Number.isSafeInteger(cursor.after) && typeof cursor.id === "string")))) : {},
        created: record(entry.created) ? Object.fromEntries(Object.entries(entry.created).filter(([key, on]) => key.startsWith("bot:") && on === true)) : {},
        creating: record(entry.creating) ? Object.fromEntries(Object.entries(entry.creating).filter(([key, on]) => key.startsWith("bot:") && on === true)) : {},
        release: Array.isArray(entry.release) ? entry.release.filter((held) => record(held) && typeof held.id === "string" && typeof held.digest === "string").slice(0, 200) : [],
        files: record(entry.files) ? Object.fromEntries(Object.entries(entry.files).filter(([path, sha]) => typeof sha === "string" && /^[a-f0-9]{64}$/u.test(sha) && path.length <= 4096)) : {},
        on: record(entry.on) ? Object.fromEntries(Object.entries(entry.on).filter(([key, on]) => /^(?:routine|call|webhook|app-event):[\w-]{1,128}$/u.test(key) && typeof on === "boolean")) : {},
      };
    }
  }
  return { v: 1, clouds };
}

/** What My Cloud's own page is told: the names of this computer's bots that wait, and counts. */
export function sendNotice(snapshot) {
  const rows = pendingRows({ rows: snapshot.rows ?? [] });
  const count = (kind) => rows.filter((row) => row.kind === kind).length;
  return {
    ready: snapshot.cloud === "ready",
    bots: rows.filter((row) => row.kind === "bot" && row.state === "only-here").map((row) => row.label),
    updatedBots: rows.filter((row) => row.kind === "bot" && row.state === "to-update").map((row) => row.label),
    skills: count("skill"), logins: count("login"), onePassword: count("1password") > 0, settings: count("setting"),
    signature: snapshot.signature ?? "",
    dismissed: Boolean(snapshot.signature) && snapshot.signature === snapshot.dismissed,
    running: Boolean(snapshot.running),
    ...(snapshot.running ? { runningReason: snapshot.running.reason, ...(snapshot.running.progress ? { progress: snapshot.running.progress } : {}),
      ...(snapshot.running.phase ? { phase: snapshot.running.phase } : {}) } : {}),
    last: snapshot.last ? told(snapshot.last, snapshot.dismissed) : null,
    whole: snapshot.whole ? told(snapshot.whole, snapshot.dismissed) : null,
    arrived: countsOf(snapshot.arrived),
  };
}

/** A send's outcome as My Cloud's page is told it: counts and reasons only. */
function told(outcome, dismissed) {
  return { at: outcome.at, reason: outcome.reason, failed: outcome.result.failed.length, sent: sentCounts(outcome.result),
    // Every failure is one trying again can't fix (1Password refused the token): no Try again.
    final: !outcome.error && outcome.result.failed.length > 0 && outcome.result.failed.every((entry) => entry.final === true),
    seen: dismissed === resultKey(outcome), ...failedSummary(outcome) };
}

/** What a send got across, in counts only: My Cloud's page names nothing of this computer's but its bots. */
function sentCounts(result) {
  return { bots: result.bots.length, updatedBots: result.updatedBots.length, skills: result.skills, logins: result.logins, onePassword: result.onePassword,
    settings: result.settings.length, chats: result.chats ? { conversations: result.chats.conversations, messages: result.chats.messages } : null };
}

/** What a send did, in counts and the names a person recognises. `connections`: apps and keys a move carried. */
function emptyResult() {
  return { bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: [], connections: 0, chats: null, failed: [], notes: [] };
}
/** What a move carried beyond a send: automations and skill extras, memory merged, files, conversations' settings. */
const movedResult = () => ({ moved: 0, memory: 0, files: { sent: 0, kept: 0 }, conversationSettings: 0 });

/**
 * @param {{
 *   local: (route: string) => Promise<Response>,
 *   cloud: {
 *     origin(): string | null,
 *     asleep(): boolean,
 *     read(route: string): Promise<Response>,
 *     open(options?: { move?: boolean }): Promise<{ call(method: string, route: string, body?: unknown): Promise<{ status: number, ok: boolean, body: any }>,
 *       upload(route: string, bytes: Uint8Array, type: string): Promise<{ status: number, ok: boolean, body: any }>, close(): Promise<void> }>,
 *   },
 *   handoff: (what: { kind: string, [key: string]: unknown }) => Promise<any>,
 *   store: { read(): unknown, write(value: unknown): void },
 *   onChange?: (snapshot: unknown) => void,
 *   now?: () => number,
 *   engineWaitMs?: number,
 *   space?: { disk(): unknown, grow(sizeGb: number): Promise<unknown> },
 *   team?: { bot: string, name: string, label: string },
 * }} deps `open({ move: true })`: the move's session, which counts as someone using My Cloud. `engineWaitMs`: how long a
 * move waits for My Cloud to run the engines whose keys it just took. `local(route, { method })`: a change on this
 * computer's server (an app event My Cloud now collects). `space`: My Cloud's plan disk and the Admin's grow. `team`: a
 * move of this one bot into a team (team-move.mjs): only the bot, its skills, files, chats and routines go, under the
 * name the team gave it; never apps, keys, logins, settings or its notes about the person. `local` is then the bot's
 * own Cloud, and `label` names the person beside a file or bot of the same name.
 */
export function createCloudSend({ local, cloud, handoff, store, onChange = () => {}, now = Date.now, engineWaitMs, space, team = null }) {
  let saved = parseSendState(safeRead(store));
  let view = { cloud: "none", plan: null, local: null, theirs: null, chats: null };
  let running = null, progress = null;
  const only = team?.bot ?? null;
  /** A route as a move of one bot asks it of either side: kept to that bot. */
  const scoped = (route) => (only ? `${route}${route.includes("?") ? "&" : "?"}bot=${only}` : route);

  function safeRead(source) { try { return source.read(); } catch { return null; } }
  function persist() { try { store.write(saved); } catch {} }
  const entry = (origin) => (saved.clouds[origin] ??= { sent: {}, off: {}, dismissed: "", last: null, whole: null, arrived: countsOf(null), chats: {}, created: {}, creating: {}, release: [], files: {}, on: {} });
  /** What a move ignores of what the person kept here: everything goes but what was removed on My Cloud. */
  const removedOnly = (off) => Object.fromEntries(Object.entries(off).filter(([, why]) => why === "removed"));
  const connectionLocal = { json: (route) => localJson(route), handoff: (what) => handoff(what) };

  function snapshot() {
    const origin = cloud.origin();
    const mine = origin ? entry(origin) : null;
    const plan = view.plan;
    return {
      cloud: origin ? view.cloud : "none",
      running: running ? { reason: running.reason, ...(progress ? { progress } : {}), ...(running.chats ? { phase: "chats" } : {}) } : null,
      rows: plan?.rows ?? [],
      cloudOnly: plan?.cloudOnly ?? [],
      pending: plan ? pendingRows(plan).length : 0,
      chats: view.chats ?? null,
      signature: plan && pendingRows(plan).length ? createHash("sha256").update(differenceSignature(plan)).digest("hex").slice(0, 32) : "",
      dismissed: mine?.dismissed ?? "",
      last: mine?.last ?? null,
      whole: mine?.whole ?? null,
      arrived: mine?.arrived ?? countsOf(null),
      cloudVersion: view.theirs?.appVersion ?? null,
      localVersion: view.local?.appVersion ?? null,
    };
  }
  const publish = () => { const value = snapshot(); try { onChange(value); } catch {} return value; };

  const allowed = (route) => LOCAL_ROUTE.test(route.replace(/[?&]bot=[\w-]{1,128}$/u, ""));
  async function localJson(route) {
    if (!allowed(route)) throw new CloudSendError("invalid", "Unsupported local request.");
    const response = await local(route);
    if (!response.ok) throw new CloudSendError("local", "OpenMausBot on this computer did not answer. Try again in a moment.");
    return response.json();
  }
  async function localBytes(route) {
    if (!allowed(route)) throw new CloudSendError("invalid", "Unsupported local request.");
    const response = await local(route);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }
  async function localSend(method, route) {
    if (!LOCAL_ROUTE.test(route) || method !== "DELETE") throw new CloudSendError("invalid", "Unsupported local request.");
    const response = await local(route, { method });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status };
  }
  const kinds = createMoveKinds({ localJson, localBytes, localSend, entry, persist, refusal, space, scoped,
    progress: (value) => { progress = value; publish(); } });

  async function readCloud() {
    let response;
    try { response = await cloud.read("/api/cloud-send"); } catch { return { state: cloud.asleep() ? "asleep" : "unreachable" }; }
    if (response.status === 404) return { state: "outdated" };
    if (!response.ok) return { state: response.status === 401 || response.status === 403 ? "signed-out" : "unreachable" };
    const summary = parseSendSummary(await response.json().catch(() => null));
    return summary ? { state: "ready", summary } : { state: "unreachable" };
  }

  /** `everything`: a move's plan, which goes past what the person once kept here. A bot a send made on My Cloud whose
   * fields were not recorded yet has them all sent again. */
  function plan(origin, mine, theirs, force = [], { everything = false } = {}) {
    const kept = entry(origin);
    const planned = planSend({ local: mine, cloud: theirs, sent: kept.sent, off: everything ? removedOnly(kept.off) : kept.off, force: [...force, ...Object.keys(kept.created)] });
    if (everything && !team) mergeRoutines(planned.rows);
    let changed = false;
    for (const [key, parts] of Object.entries(planned.baseline)) { kept.sent[key] = { ...kept.sent[key], ...parts }; changed = true; }
    for (const key of planned.removed) { kept.off[key] = "removed"; delete kept.sent[key]; delete kept.created[key]; changed = true; }
    if (everything) {
      // A move has nobody to ask: a part both sides hold otherwise is My Cloud's (§2.2), and recorded as settled, so the
      // move's check (manifestGaps) agrees with this plan instead of calling it missing on every pass.
      const here = new Map((mine?.items ?? []).map((item) => [item.key, item])), there = new Map((theirs?.items ?? []).map((item) => [item.key, item]));
      for (const row of planned.rows) {
        // A routine's runs are history My Cloud adds by id and never drops: when they are all that differs, it goes.
        if (row.kind === "routine" && row.differs?.includes("runs") && !row.differs.includes("def")) {
          row.differs = row.differs.filter((part) => part !== "runs");
          row.parts = [...(row.parts ?? []), "runs"];
          row.state = "to-update";
          if (!row.differs.length) delete row.differs;
        }
        for (const part of row.differs ?? []) {
          kept.sent[row.key] = { ...kept.sent[row.key], [part]: [here.get(row.key).parts[part], there.get(row.key)?.parts[part] ?? EMPTY] };
          changed = true;
        }
      }
    }
    if (changed) persist();
    return planned;
  }

  /** The conversations still to go, for Settings and the page; what was known before when this computer did not answer. */
  const chatsLeft = (origin, theirs) => theirs?.chats
    ? chatsWaiting(origin, theirs).then(({ ready, busy }) => ({ waiting: ready.length + busy })).catch(() => view.chats ?? null)
    : Promise.resolve(null);

  /** Reads both sides and plans; never writes to My Cloud. */
  async function compare() {
    const origin = cloud.origin();
    if (!origin) { view = { cloud: "none", plan: null, local: null, theirs: null, chats: null }; return publish(); }
    if (cloud.asleep()) { view = { ...view, cloud: "asleep" }; return publish(); }
    const [mine, theirs] = await Promise.all([localJson("/api/cloud-send").then(parseSendSummary).catch(() => null), readCloud()]);
    if (!mine) { view = { ...view, cloud: "local-unavailable" }; return publish(); }
    if (theirs.state !== "ready") { view = { cloud: theirs.state, plan: null, local: mine, theirs: null, chats: null }; return publish(); }
    view = { cloud: "ready", plan: plan(origin, mine, theirs.summary), local: mine, theirs: theirs.summary, chats: await chatsLeft(origin, theirs.summary) };
    return publish();
  }

  /** One send at a time; one asked while another runs waits for it, then runs as it was asked. A move (`reason: "move"`)
   * carries everything; its final pass (`final`) carries the sign-ins that refresh themselves too, and this computer lets
   * go of each once My Cloud has it. */
  async function send({ keys = null, force = [], reason = "button", final = false } = {}) {
    while (running) await running.promise.catch(() => {});
    const origin = cloud.origin();
    if (!origin) throw new CloudSendError("no_cloud", "This computer has no My Cloud yet.");
    const job = { reason, final: reason === "move" && final === true, promise: null, chats: false };
    running = job;
    progress = null;
    publish();
    job.promise = (async () => {
      try { return await sendTo(origin, job, { keys, force: Array.isArray(force) ? force.filter((key) => typeof key === "string") : [], reason }); }
      catch (error) {
        // Kept as this send's outcome, so the strip and Settings say why, instead of an earlier send's result.
        const kept = entry(origin);
        kept.last = { at: now(), reason, result: emptyResult(), error: sentence(error?.message) ?? "Nothing could be sent to My Cloud. Try again." };
        if (!keys && CHAT_REASONS.has(reason)) kept.whole = kept.last;
        persist();
        if (unanswered(error)) view = { ...view, cloud: "unreachable" };
        throw error;
      }
      finally { running = null; progress = null; publish(); }
    })();
    return job.promise;
  }

  async function sendTo(origin, job, { keys, force, reason }) {
    const result = { ...emptyResult(), ...(reason === "move" ? movedResult() : {}) };
    const mine = parseSendSummary(await localJson(reason === "move" ? scoped("/api/cloud-send?move=1") : "/api/cloud-send"));
    if (!mine) throw new CloudSendError("local", "OpenMausBot on this computer did not answer. Try again in a moment.");
    const withChats = !keys && CHAT_REASONS.has(reason);
    const latest = await sendItems(origin, mine, result, { keys, force, job, withChats });
    const outcome = { at: now(), reason, result };
    const kept = entry(origin);
    kept.last = outcome;
    if (withChats) kept.whole = outcome;
    kept.arrived = addCounts(kept.arrived, sentCounts(result));
    persist();
    view = { cloud: "ready", plan: plan(origin, mine, latest), local: mine, theirs: latest, chats: await chatsLeft(origin, latest) };
    return outcome;
  }

  /** A move goes only to a Cloud that says it takes one: an older one would lose the owner's lines and the checks. */
  async function assertTakesMove(session) {
    const described = await session.call("GET", "/.well-known/openmausbot/environment");
    if (!(Number(described.body?.capabilities?.move) >= 1)) throw new CloudSendError("outdated", OUTDATED_FOR_MOVE);
  }

  /** Every item that waits, and then the chats, over one owner session, always signed out; what My Cloud holds after. A
   * move's apps and keys go first, so the bots that follow find their engines; then the skills only a move carries, the
   * bots, their memory and files, the chats with each conversation's settings, and last the automations, switched off. An
   * app event goes only in the final pass, when this computer lets go of it. */
  async function sendItems(origin, mine, result, { keys, force, job, withChats }) {
    const move = job.reason === "move";
    const summaryRoute = move ? scoped("/api/cloud-send?move=1") : "/api/cloud-send";
    const session = await cloud.open(move ? { move: true } : undefined).catch((error) => { throw new CloudSendError("session", sentence(error?.message) ?? "This app could not sign in to My Cloud. Try again.", { cause: error }); });
    try {
      const before = await session.call("GET", summaryRoute);
      if (before.status === 404) throw new CloudSendError("outdated", move ? OUTDATED_FOR_MOVE : "My Cloud needs an update before it can receive bots from this computer. It updates by itself; try again later.");
      const theirs = before.ok ? parseSendSummary(before.body) : null;
      if (!theirs) throw new CloudSendError("unreachable", refusal(before, "My Cloud did not answer. Try again."));
      let computer = team ? { label: team.label } : null;
      if (move) {
        await assertTakesMove(session);
        // A bot moving into a team carries nothing of the person's: their apps and keys stay.
        if (!team) computer = await moveConnections(origin, session, result, job.final);
      }
      settleCreating(origin, theirs);
      const planned = plan(origin, mine, theirs, force, { everything: move });
      const wanted = keys ? new Set(keys) : null;
      const rows = pendingRows(planned).filter((row) => !wanted || wanted.has(row.key) || (row.bot && wanted.has(itemKey.bot(row.bot))))
        .filter((row) => row.kind !== "app-event" || job.final);
      const total = rows.length;
      progress = total ? { done: 0, total } : null;
      publish();
      const cloudBots = new Set(theirs.items.filter((item) => item.kind === "bot" && item.id).map((item) => item.id));
      const localItems = new Map(mine.items.map((item) => [item.key, item]));
      const cloudItems = new Map(theirs.items.map((item) => [item.key, item]));
      const ctx = { origin, session, result, cloudBots, localItems, cloudItems, planned: new Map(planned.rows.map((row) => [row.key, row])), bots: null, skillLists: new Map(),
        sentKeys: new Set(), sentParts: {}, recorded: new Set(), move, ownMove: move && !team, summaryRoute, computer: computer?.label ?? null };
      const order = { "library-skill": 0, "imported-skill": 0, bot: 1, skill: 2, setting: 3, login: 4, "1password": 5 };
      const automations = new Set(AUTOMATION_KINDS);
      const goRow = async (row) => {
        try { await sendRow(ctx, row); }
        catch (error) { result.failed.push({ key: row.key, kind: row.kind, label: row.label, error: sentence(error?.message) ?? "It could not be sent.", ...(error?.final === true ? { final: true } : {}) }); }
        await recordItem(ctx, row.key).catch(() => {});
        if (progress && !job.chats) progress = { done: progress.done + 1, total };
        publish();
      };
      for (const row of rows.filter((entry) => !automations.has(entry.kind)).sort((a, b) => order[a.kind] - order[b.kind])) await goRow(row);
      const moved = move ? await movedBots(ctx) : [];
      if (move) {
        // Its notes about the person stay with them when a bot moves into a team.
        if (!team) await kinds.moveMemory(ctx, moved);
        try { await kinds.moveFiles(ctx, moved, computer?.label); }
        catch (error) { result.failed.push({ key: "files", kind: "files", label: "Files", error: sentence(error?.message) ?? "The files could not be sent." }); }
      }
      const after = parseSendSummary((await session.call("GET", summaryRoute)).body);
      if (after) remember(origin, ctx, after);
      const latest = after ?? theirs;
      if (withChats && latest.chats) {
        job.chats = true;
        progress = null;
        publish();
        try {
          await sendChatRows(origin, session, latest, result, { everything: move });
          if (move) await stampHeld(origin, session, latest);
        } catch (error) { result.failed.push({ key: "chats", kind: "chats", label: "Chats", error: sentence(error?.message) ?? "The chats could not be added." }); }
      }
      if (move) {
        try { result.conversationSettings = await kinds.moveSettings(ctx); }
        catch (error) { result.failed.push({ key: "conversation-settings", kind: "chats", label: "Chats", error: sentence(error?.message) ?? "The chats' settings could not be added." }); }
        const last = rows.filter((entry) => automations.has(entry.kind));
        for (const row of last) await goRow(row);
        // The pass's closing plan reads My Cloud as it is now: read before the automations went, it would take each one
        // just carried for one removed there.
        if (last.length) return parseSendSummary((await session.call("GET", summaryRoute)).body) ?? latest;
      }
      return latest;
    } finally {
      try { await session.close(); } catch {}
    }
  }

  /** The bots of this computer's that My Cloud has now, with their names. */
  async function movedBots(ctx) {
    const bots = await localBots(ctx);
    return [...ctx.cloudBots].filter((id) => bots.has(id) && ctx.localItems.has(itemKey.bot(id))).map((id) => ({ id, name: bots.get(id).name }));
  }

  /** This computer's apps and keys, MCP servers, HighLevel and connected apps, over the move's session. A sign-in that
   * refreshes itself goes only in the final pass; this computer then lets go of its copy once My Cloud has it, and one it
   * could not let go of yet is kept and let go of on the next final pass. */
  async function moveConnections(origin, session, result, final) {
    const kept = entry(origin);
    const failed = (id, label, error, last) => result.failed.push({ key: id, kind: "connection", label, error: sentence(error) ?? "It did not move.", ...(last ? { final: true } : {}) });
    if (final && kept.release.length) {
      kept.release = await releaseConnections(kept.release, { local: connectionLocal, target: session }).catch(() => kept.release);
      persist();
    }
    let collected;
    try { collected = await collectConnections(connectionLocal); }
    catch (error) { failed("connections", "Apps and keys", error?.message, false); return null; }
    const moved = await sendConnections(collected, session, { local: connectionLocal, signIns: final, ...(engineWaitMs !== undefined ? { waitMs: engineWaitMs } : {}),
      onProgress: (step) => { progress = { done: step.done, total: step.total }; publish(); } });
    result.connections += moved.moved.length + moved.runsHere.length;
    for (const failure of moved.failed) failed(failure.id, failure.label, failure.message, failure.final);
    for (const held of moved.held ?? []) result.notes.push({ kind: "held", connection: held.label });
    if (moved.release.length) {
      kept.release = [...kept.release.filter((held) => !moved.release.some((next) => next.id === held.id)), ...moved.release];
      persist();
    }
    return collected.computer;
  }

  /** The conversations whose newest row My Cloud has not taken, not answered in now: of bots My Cloud has and that are
   * not kept here (`everything`: whatever was kept here), and of rooms, which My Cloud makes once one of their bots is
   * there. A room nobody wrote in yet goes as its active thread with no rows (`empty`), once, so My Cloud makes it too. */
  async function chatsWaiting(origin, theirs, { everything = false } = {}) {
    const listed = await localJson(scoped("/api/cloud-send/chats"));
    const kept = entry(origin);
    const cloudBots = new Set(theirs.items.filter((item) => item.kind === "bot" && item.id).map((item) => item.id));
    const id = (value) => typeof value === "string" && /^[\w-]{1,128}$/u.test(value);
    const thread = (value) => typeof value === "string" && /^[\w-]{1,200}$/u.test(value);
    const keptHere = (botId) => everything ? kept.off[itemKey.bot(botId)] === "removed" : Boolean(kept.off[itemKey.bot(botId)]);
    // My Cloud makes the room once one of its bots is there, as it does from a room's rows; one with no bot never goes.
    const empty = (Array.isArray(listed?.rooms) ? listed.rooms : []).filter((room) => record(room) && id(room.room) && thread(room.threadId)
      && Array.isArray(room.members) && room.members.length > 0)
      .map((room) => ({ room: room.room, threadId: room.threadId, last: 0, lastId: "", busy: false, empty: true }));
    const conversations = [...(Array.isArray(listed?.conversations) ? listed.conversations : []).filter((head) => record(head)
      && (id(head.bot) !== id(head.room)) && thread(head.threadId) && Number.isSafeInteger(head.last) && typeof head.lastId === "string"), ...empty];
    const waiting = conversations.filter((head) => {
      const cursor = kept.chats[head.threadId];
      if (cursor === "removed" || (head.bot && (!cloudBots.has(head.bot) || keptHere(head.bot)))) return false;
      return !cursor || cursor.after !== head.last || cursor.id !== head.lastId;
    });
    return { dataDir: typeof listed?.dataDir === "string" ? listed.dataDir : "", ready: waiting.filter((head) => !head.busy), busy: waiting.filter((head) => head.busy).length,
      owner: team && typeof listed?.owner === "string" && /^p_[\w-]{22}$/u.test(listed.owner) ? listed.owner : null };
  }

  /** Each waiting conversation's new rows, page by page, a few conversations per request; the cursor moves only past
   * what My Cloud took, and once My Cloud did not take a page, the conversation's later pages wait for the next send too.
   * The attachments those rows name go first, unless My Cloud has them. `result.chats.left`: the conversations that did
   * not all go (a bot answering in one, or My Cloud not taking a page), for the next send. */
  async function sendChatRows(origin, session, theirs, result, { everything = false } = {}) {
    const { dataDir, ready, busy, owner: from } = await chatsWaiting(origin, theirs, { everything });
    const kept = entry(origin);
    const total = ready.length;
    const held = new Set();
    let batch = [], bytes = 0, done = 0;
    result.chats = { conversations: 0, messages: 0, left: busy };
    progress = total ? { done: 0, total } : null;
    publish();
    const flush = async () => {
      if (!batch.length) return;
      const names = [...new Set(batch.flatMap((page) => page.attachments))];
      for (let i = 0; i < names.length; i += ATTACHMENT_NAMES) {
        const asked = names.slice(i, i + ATTACHMENT_NAMES);
        const checked = await session.call("POST", "/api/cloud-send/chats/attachments", { names: asked });
        if (!checked.ok) throw new CloudSendError("refused", refusal(checked, "My Cloud could not take the chats' attachments."));
        for (const name of Array.isArray(checked.body?.missing) ? checked.body.missing.filter((name) => asked.includes(name)) : []) {
          const file = await localBytes(`/api/cloud-send/chats/attachment/${name}`);
          if (!file) continue;
          const stored = await session.upload(`/api/cloud-send/chats/attachment/${name}`, file, "application/octet-stream");
          if (stored.status === 413 || stored.status === 507) {
            result.failed.push({ key: `attachment:${name}`, kind: "chats", label: "Attachment", error: stored.status === 507
              ? "My Cloud's room for attachments is full, so an attachment did not go. Its chat went without it."
              : "An attachment is bigger than My Cloud takes, so it did not go. Its chat went without it.", ...(stored.status === 413 ? { final: true } : {}) });
            continue;
          }
          if (!stored.ok) throw new CloudSendError("refused", refusal(stored, "My Cloud could not take an attachment of the chats."));
        }
      }
      // Into a team: whose lines on My Cloud become the mover's there.
      const answer = await session.call("POST", "/api/cloud-send/chats", { v: 1, dataDir, ...(from ? { owner: from } : {}),
        conversations: batch.map(({ owner, threadId, task, rows, leaf, sent }) => ({ ...owner, threadId, task, rows, leaf, sent })) });
      if (!answer.ok) throw new CloudSendError("refused", refusal(answer, "My Cloud could not add the chats."));
      const accepted = new Set(Array.isArray(answer.body?.accepted) ? answer.body.accepted : []);
      const removed = new Set(Array.isArray(answer.body?.removed) ? answer.body.removed : []);
      for (const page of batch) {
        if (accepted.has(page.threadId) && typeof page.lastId === "string") kept.chats[page.threadId] = { after: page.last, id: page.lastId };
        else {
          if (!held.has(page.threadId) && !(removed.has(page.threadId) && page.sent)) result.chats.left++;
          held.add(page.threadId);
          if (removed.has(page.threadId) && page.sent) kept.chats[page.threadId] = "removed";
        }
      }
      result.chats.conversations += Number.isSafeInteger(answer.body?.conversations) ? answer.body.conversations : 0;
      result.chats.messages += Number.isSafeInteger(answer.body?.messages) ? answer.body.messages : 0;
      persist();
      batch = []; bytes = 0;
    };
    for (const head of ready) {
      let cursor = record(kept.chats[head.threadId]) ? kept.chats[head.threadId] : null;
      for (let pages = 0; pages < 10_000 && !held.has(head.threadId); pages++) {
        const page = await localJson(`/api/cloud-send/chats/rows?thread=${head.threadId}&after=${cursor?.after ?? 0}&id=${encodeURIComponent(cursor?.id ?? "")}`);
        if (!record(page) || !Array.isArray(page.rows)) break;
        if (page.restarted) delete kept.chats[head.threadId];
        // A room nobody wrote in yet: its thread goes with no rows, which My Cloud takes as the room to make.
        const room = head.empty === true && !page.rows.length && !page.lastId && record(page.roomInfo);
        if (page.rows.length || room) {
          const size = Buffer.byteLength(JSON.stringify(page.rows), "utf8");
          if (bytes + size > CHATS_BATCH_BYTES || batch.length >= CHATS_BATCH_PAGES) await flush();
          if (held.has(head.threadId)) break;
          const owner = head.room ? { room: head.room, ...(record(page.roomInfo) ? { roomInfo: page.roomInfo } : {}) } : { bot: head.bot };
          batch.push({ owner, threadId: head.threadId, task: record(page.task) ? page.task : null, rows: page.rows, leaf: typeof page.leaf === "string" ? page.leaf : null,
            sent: record(kept.chats[head.threadId]), last: room ? 0 : page.last, lastId: room ? "" : page.lastId,
            attachments: Array.isArray(page.attachments) ? page.attachments.filter((name) => typeof name === "string" && /^[A-Za-z0-9-]{1,80}\.[A-Za-z0-9]{1,10}$/u.test(name)) : [] });
          bytes += size;
        } else if (page.lastId) kept.chats[head.threadId] = { after: page.last, id: page.lastId };
        if (!page.more || !page.lastId) break;
        cursor = { after: page.last, id: page.lastId };
      }
      progress = { done: ++done, total };
      publish();
    }
    await flush();
  }

  /** A move has My Cloud make its owner's lines and answers its owner's among the rows it already held of this computer's
   * bots and rooms, which an earlier send or a Bring left naming nobody: this computer's row ids go, never a row. */
  async function stampHeld(origin, session, theirs) {
    const listed = await localJson(scoped("/api/cloud-send/chats"));
    const kept = entry(origin);
    const cloudBots = new Set(theirs.items.filter((item) => item.kind === "bot" && item.id).map((item) => item.id));
    const threads = (Array.isArray(listed?.conversations) ? listed.conversations : []).filter((head) => record(head) && (cloudBots.has(head.bot) || typeof head.room === "string")
      && typeof head.threadId === "string" && /^[\w-]{1,200}$/u.test(head.threadId) && kept.chats[head.threadId] !== "removed").map((head) => head.threadId);
    let batch = [], ids = 0;
    const flush = async () => {
      if (!batch.length) return;
      const answer = await session.call("POST", "/api/cloud-send/chats/owner", { v: 1, conversations: batch });
      if (!answer.ok) throw new CloudSendError("refused", refusal(answer, "My Cloud could not keep the chats' lines as yours."));
      batch = []; ids = 0;
    };
    for (const threadId of threads) {
      for await (const chunk of rowIdChunks(localJson, threadId)) {
        if (ids + chunk.ids.length > ROW_IDS || batch.length >= ROW_ID_CONVERSATIONS) await flush();
        batch.push({ threadId, ids: chunk.ids });
        ids += chunk.ids.length;
      }
    }
    await flush();
  }

  /** What was sent is recorded against what My Cloud holds right after, a part it refused included: that part is tried
   * again only once it changes here. `keys`: only these. */
  function remember(origin, ctx, after, keys = ctx.sentKeys) {
    const kept = entry(origin);
    const there = new Map(after.items.map((item) => [item.key, item]));
    for (const key of keys) {
      const mine = ctx.localItems.get(key), theirs = there.get(key);
      if (!mine || !theirs) continue;
      kept.sent[key] = { ...kept.sent[key] };
      for (const part of ctx.sentParts[key] ?? Object.keys(mine.parts)) kept.sent[key][part] = [mine.parts[part], theirs.parts[part] ?? EMPTY];
      delete kept.created[key];
      ctx.recorded.add(key);
    }
  }

  /** Each item is recorded as soon as it went, from My Cloud's own answer for it and its skills, so a send cut short goes
   * on from the next item instead of judging what already went as My Cloud's own change. */
  async function recordItem(ctx, key) {
    const keys = [...ctx.sentKeys].filter((sent) => !ctx.recorded.has(sent));
    if (!keys.length) return;
    const answer = await ctx.session.call("GET", scoped(`/api/cloud-send?item=${encodeURIComponent(key)}${ctx.move ? "&move=1" : ""}`));
    const after = answer.ok ? parseSendSummary(answer.body) : null;
    if (!after) return;
    remember(ctx.origin, ctx, after, keys);
    persist();
  }

  /** A bot a send asked My Cloud to make and never heard back about: one My Cloud has is that send's own, so all its
   * fields go (`created`); one it lacks was never made, and goes as new. */
  function settleCreating(origin, theirs) {
    const kept = entry(origin);
    const waiting = Object.keys(kept.creating ?? {});
    if (!waiting.length) return;
    const there = new Set(theirs.items.map((item) => item.key));
    for (const key of waiting) {
      if (there.has(key)) { kept.sent[key] ??= {}; kept.created[key] = true; }
      delete kept.creating[key];
    }
    persist();
  }

  const done = (ctx, key, parts = null) => { ctx.sentKeys.add(key); if (parts) ctx.sentParts[key] = parts; };
  /** A bot this send made on My Cloud: its fields go whatever My Cloud's defaults are, until they are recorded, and it
   * counts as sent before, so one removed there before then stays removed. */
  function markCreated(ctx, key) {
    const kept = entry(ctx.origin);
    kept.sent[key] ??= {};
    kept.created[key] = true;
    delete kept.creating[key];
    persist();
  }

  async function localBots(ctx) {
    if (!ctx.bots) {
      const listed = await localJson("/api/bots?messages=0");
      ctx.bots = new Map((Array.isArray(listed?.bots) ? listed.bots : []).filter((bot) => record(bot) && typeof bot.id === "string").map((bot) => [bot.id, bot]));
    }
    return ctx.bots;
  }
  async function localSkills(ctx, botId) {
    if (!ctx.skillLists.has(botId)) {
      const listed = await localJson(`/api/bots/${botId}/skills`);
      ctx.skillLists.set(botId, new Map((Array.isArray(listed?.skills) ? listed.skills : []).filter((skill) => record(skill) && typeof skill.name === "string").map((skill) => [skill.name, skill])));
    }
    return ctx.skillLists.get(botId);
  }

  async function sendRow(ctx, row) {
    if (MOVE_KINDS.includes(row.kind)) { await kinds.sendKind(ctx, row); ctx.result.moved++; return done(ctx, row.key); }
    if (row.kind === "bot") return row.state === "only-here" ? addBot(ctx, row) : updateBot(ctx, row);
    if (row.kind === "skill") return sendSkill(ctx, row);
    if (row.kind === "setting") return sendSetting(ctx, row);
    if (row.kind === "login") return sendLogin(ctx, row);
    if (row.kind === "1password") return sendOnePassword(ctx, row);
  }

  async function patchBot(ctx, bot, parts) {
    const refused = {};
    const whole = await ctx.session.call("PATCH", `/api/bots/${bot.id}`, botPatch(bot, parts, ctx.cloudBots));
    if (whole.ok) return refused;
    for (const part of parts) {
      const body = botPatch(bot, [part], ctx.cloudBots);
      if (!Object.keys(body).length) continue;
      const one = await ctx.session.call("PATCH", `/api/bots/${bot.id}`, body);
      if (!one.ok) refused[part] = refusal(one, "My Cloud refused this setting.");
    }
    return refused;
  }

  async function sendPicture(ctx, bot) {
    const name = typeof bot.avatarUrl === "string" ? /^\/api\/attachments\/([A-Za-z0-9-]{1,80}\.(png|jpg|gif|webp))$/u.exec(bot.avatarUrl) : null;
    if (!name) return null;
    const bytes = await localBytes(`/api/attachments/${name[1]}`);
    if (!bytes) return "The picture could not be read on this computer.";
    const uploaded = await ctx.session.upload("/api/attachments", bytes, PICTURE_TYPES[name[2]]);
    const stored = typeof uploaded.body?.path === "string" ? uploaded.body.path.replaceAll("\\", "/").split("/").pop() : null;
    if (!uploaded.ok || !stored) return refusal(uploaded, "My Cloud could not store the picture.");
    const set = await ctx.session.call("PATCH", `/api/bots/${bot.id}`, { avatarUrl: `/api/attachments/${stored}` });
    return set.ok ? null : refusal(set, "My Cloud could not use the picture.");
  }

  /** A move keeps both of two different bots of one name: the one arriving is named after this computer. */
  async function arrivingName(ctx, bot) {
    if (team) return team.name;
    if (!ctx.move || !ctx.computer) return bot.name;
    ctx.cloudNames ??= ctx.session.call("GET", "/api/bots?messages=0")
      .then((listed) => (Array.isArray(listed.body?.bots) ? listed.body.bots : []).filter(record), () => []);
    const same = (name) => typeof name === "string" && name.trim().toLocaleLowerCase() === bot.name.trim().toLocaleLowerCase();
    const taken = (await ctx.cloudNames).some((theirs) => theirs.id !== bot.id && same(theirs.name) && !(bot.defaultBot && theirs.defaultBot));
    return taken ? `${bot.name} (${ctx.computer})`.slice(0, 80) : bot.name;
  }

  async function addBot(ctx, row) {
    const bot = (await localBots(ctx)).get(row.id);
    if (!bot) throw new CloudSendError("gone", "This bot is no longer on this computer.");
    const model = record(bot.modelSelection) ? pick(bot.modelSelection, ["instanceId", "model", "effort", "variant"]) : null;
    // A bot that moves into a team gets a main chat of the team's own there; its chats with the person arrive as theirs.
    const base = { id: bot.id, ...(team ? {} : { threadId: bot.threadId }), name: await arrivingName(ctx, bot), useDefaults: false };
    // Kept before asking: a send cut short while My Cloud makes the bot still knows the bot is its own (settleCreating).
    entry(ctx.origin).creating[row.key] = true;
    persist();
    let created = await ctx.session.call("POST", "/api/bots", { ...base, ...(model ? { modelSelection: model, requireAvailableModel: true } : {}) });
    let modelKept = Boolean(model) && created.ok;
    if (!created.ok && model && created.status === 400) {
      created = await ctx.session.call("POST", "/api/bots", base);
      modelKept = false;
    }
    if (!created.ok) throw new CloudSendError("refused", refusal(created, "My Cloud could not add this bot."));
    ctx.cloudBots.add(bot.id);
    markCreated(ctx, row.key);
    const parts = Object.keys(BOT_PARTS).filter((part) => part !== "name" && (part !== "model" || modelKept));
    const refused = await patchBot(ctx, bot, parts);
    if (ctx.move) Object.assign(refused, await kinds.sendBotFields(ctx, bot.id, Object.keys(MOVE_BOT_PARTS)));
    const picture = await sendPicture(ctx, bot);
    if (picture) refused[PICTURE_PART] = picture;
    done(ctx, row.key);
    ctx.result.bots.push(bot.name);
    if ((!modelKept && model) || refused.model) ctx.result.notes.push({ kind: "model", bot: bot.name });
    if (Object.keys(refused).some((part) => part !== "model")) ctx.result.notes.push({ kind: "settings", bot: bot.name });
    for (const [key, item] of ctx.localItems) {
      if (item.kind !== "skill" || item.bot !== bot.id || ctx.planned.get(key)?.state !== "only-here") continue;
      try { await putSkill(ctx, bot.id, item.id, false); done(ctx, key); ctx.result.skills++; }
      catch (error) { ctx.result.failed.push({ key, kind: "skill", label: item.label, error: sentence(error?.message) ?? "It could not be sent." }); }
    }
    if (!ctx.move) await sendMemory(ctx, bot.id).catch(() => ctx.result.notes.push({ kind: "memory", bot: bot.name }));
  }

  async function updateBot(ctx, row) {
    const bot = (await localBots(ctx)).get(row.id);
    if (!bot) throw new CloudSendError("gone", "This bot is no longer on this computer.");
    const parts = row.parts ?? [];
    const fields = parts.filter((part) => part !== PICTURE_PART && !MOVE_BOT_PARTS[part]);
    const refused = fields.length ? await patchBot(ctx, bot, fields) : {};
    const moveParts = ctx.move ? parts.filter((part) => MOVE_BOT_PARTS[part]) : [];
    if (moveParts.length) Object.assign(refused, await kinds.sendBotFields(ctx, bot.id, moveParts));
    if (parts.includes(PICTURE_PART)) {
      const picture = await sendPicture(ctx, bot);
      if (picture) refused[PICTURE_PART] = picture;
    }
    done(ctx, row.key, parts);
    if (Object.keys(refused).length < parts.length) ctx.result.updatedBots.push(bot.name);
    if (refused.model) ctx.result.notes.push({ kind: "model", bot: bot.name });
    if (Object.keys(refused).some((part) => part !== "model")) ctx.result.notes.push({ kind: "settings", bot: bot.name });
    if (entry(ctx.origin).created[row.key] && !ctx.move) await sendMemory(ctx, bot.id).catch(() => ctx.result.notes.push({ kind: "memory", bot: bot.name }));
  }

  /** The bot's own skill, by its SKILL.md: My Cloud's copy is replaced when the text changed here. */
  async function putSkill(ctx, botId, name, replace) {
    const skill = (await localSkills(ctx, botId)).get(name);
    if (!skill) throw new CloudSendError("gone", "This skill is no longer on this computer.");
    const text = await localJson(`/api/bots/${botId}/skills/${name}`);
    if (typeof text?.text !== "string") throw new CloudSendError("local", "The skill could not be read on this computer.");
    const install = (from, body) => ctx.session.call("POST", `/api/bots/${botId}/skill-template`, {
      name, description: typeof from.description === "string" ? from.description.slice(0, 1024) : "", warnings: [],
      source: typeof from.source === "string" && from.source.trim() ? from.source.slice(0, 2000) : "this computer",
      text: body, enabled: from.enabled === true,
    });
    let previous = null;
    if (replace) {
      const listed = await ctx.session.call("GET", `/api/bots/${botId}/skills`);
      const own = await ctx.session.call("GET", `/api/bots/${botId}/skills/${name}`);
      const entry = Array.isArray(listed.body?.skills) ? listed.body.skills.find((candidate) => candidate?.name === name) : null;
      if (!own.ok || typeof own.body?.text !== "string" || !entry) throw new CloudSendError("refused", refusal(own, "My Cloud's copy of this skill could not be read, so it was left as it is."));
      previous = { entry, text: own.body.text };
      const removed = await ctx.session.call("DELETE", `/api/bots/${botId}/skills/${name}`);
      if (!removed.ok) throw new CloudSendError("refused", refusal(removed, "My Cloud could not replace this skill."));
    }
    const added = await install(skill, text.text);
    if (added.ok) return;
    if (previous) await install(previous.entry, previous.text).catch(() => null);
    throw new CloudSendError("refused", refusal(added, "My Cloud could not add this skill."));
  }

  async function sendSkill(ctx, row) {
    const there = ctx.cloudItems.get(row.key);
    const parts = row.parts ?? [];
    if (there && parts.length === 1 && parts[0] === "on") {
      const skill = (await localSkills(ctx, row.bot)).get(row.id);
      const set = await ctx.session.call("PATCH", `/api/bots/${row.bot}/skills/${row.id}`, { enabled: skill?.enabled === true });
      if (!set.ok) throw new CloudSendError("refused", refusal(set, "My Cloud could not switch this skill."));
    } else {
      if (!ctx.cloudBots.has(row.bot)) throw new CloudSendError("no_bot", "Its bot is not on My Cloud.");
      await putSkill(ctx, row.bot, row.id, Boolean(there));
    }
    done(ctx, row.key, there && parts.length === 1 && parts[0] === "on" ? parts : null);
    ctx.result.skills++;
  }

  /** A new bot's memory notes go with it once; after that each side's bot keeps its own memory. */
  async function sendMemory(ctx, botId) {
    const overview = await localJson(`/api/bots/${botId}/memory`);
    const files = ["MEMORY.md", ...(Array.isArray(overview?.topics) ? overview.topics.map((topic) => topic?.path).filter((path) => typeof path === "string") : [])];
    for (const path of files.slice(0, MEMORY_FILES)) {
      const doc = await localJson(`/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`);
      if (!doc?.exists || typeof doc.text !== "string" || !doc.text.trim()) continue;
      const put = await ctx.session.call("PUT", `/api/bots/${botId}/memory/file`, { path, text: doc.text });
      if (!put.ok) throw new CloudSendError("refused", refusal(put, "My Cloud could not save a memory note."));
    }
  }

  async function sendSetting(ctx, row) {
    const config = await localJson("/api/config");
    const parts = row.parts ?? ["name", "email", "about", "value"];
    let body;
    if (row.key === itemKey.setting("profile")) {
      const profile = record(config?.profile) ? config.profile : {};
      const fields = { name: "name", email: "email", about: "aboutMe" };
      body = { profile: Object.fromEntries(parts.filter((part) => fields[part] && typeof profile[fields[part]] === "string").map((part) => [fields[part], profile[fields[part]]])) };
    } else if (row.key === itemKey.setting("language")) {
      if (typeof config?.language !== "string") return;
      body = { language: config.language };
    } else return;
    const saved = await ctx.session.call("PATCH", "/api/config", body);
    if (!saved.ok) throw new CloudSendError("refused", refusal(saved, "My Cloud could not save this setting."));
    done(ctx, row.key, parts);
    ctx.result.settings.push(row.label);
  }

  async function sendLogin(ctx, row) {
    const handed = await handoff({ kind: "login", id: row.id });
    const login = handed?.login;
    if (!record(login)) throw new CloudSendError("local", "This login could not be read on this computer.");
    const kept = botsOnCloud(login.bots, ctx.cloudBots);
    const saved = await ctx.session.call("POST", "/api/logins", { site: login.site, username: login.username, password: login.password,
      ...(login.totp ? { totp: login.totp } : {}), bots: kept, exactHost: login.exactHost === true });
    if (!saved.ok) throw new CloudSendError("refused", refusal(saved, "My Cloud could not save the login."));
    if (Array.isArray(login.bots) && kept.length < login.bots.length) ctx.result.notes.push({ kind: "narrowed", login: row.label });
    done(ctx, row.key);
    ctx.result.logins++;
  }

  async function sendOnePassword(ctx, row) {
    const handed = await handoff({ kind: "1password" });
    const onePassword = handed?.onePassword;
    if (!record(onePassword) || typeof onePassword.token !== "string") throw new CloudSendError("local", "1Password is not connected on this computer.");
    const parts = row.parts ?? ["token", "vaults"];
    if (row.state === "only-here" || parts.includes("token")) {
      const connected = await ctx.session.call("POST", "/api/logins/1password", { token: onePassword.token });
      if (!connected.ok) throw onePasswordRefusal(connected);
    }
    for (const [vault, bots] of Object.entries(onePassword.grants ?? {})) {
      if (!VAULT_ID.test(vault)) continue;
      const granted = await ctx.session.call("PATCH", `/api/logins/1password/vaults/${encodeURIComponent(vault)}`, { bots: botsOnCloud(bots, ctx.cloudBots) });
      if (!granted.ok && granted.status !== 404) throw new CloudSendError("refused", refusal(granted, "My Cloud connected 1Password but could not keep its vaults to the same bots."));
    }
    done(ctx, row.key);
    ctx.result.onePassword = true;
  }

  /**
   * What did not arrive of what a move carried, from both sides' own answers, over one owner session that counts as
   * someone using My Cloud: `gaps`, the manifests compared (cloud-send-check.mjs); `chats`, each conversation's rows, its
   * owner's lines and its visible path; `attachments`, the stored ones My Cloud lacks; `secrets`, each credential by its
   * fingerprint. Left out: what was removed on My Cloud, and a 1Password token 1Password itself refused. `ok` when
   * nothing is missing.
   */
  async function check() {
    const origin = cloud.origin();
    if (!origin) throw new CloudSendError("no_cloud", "This computer has no My Cloud yet.");
    const kept = entry(origin);
    const session = await cloud.open({ move: true }).catch((error) => { throw new CloudSendError("session", sentence(error?.message) ?? "This app could not sign in to My Cloud. Try again.", { cause: error }); });
    try {
      await assertTakesMove(session);
      const here = await localJson(scoped("/api/cloud-send/manifest"));
      const answer = await session.call("GET", scoped("/api/cloud-send/manifest"));
      if (!answer.ok) throw new CloudSendError("unreachable", refusal(answer, "My Cloud did not answer. Try again."));
      const removed = new Set([...Object.entries(kept.off).filter(([, why]) => why === "removed").map(([key]) => key),
        ...Object.entries(kept.chats).filter(([, cursor]) => cursor === "removed").map(([threadId]) => threadId),
        ...roomsRemovedThere(here, answer.body, kept.chats)]);
      const refused = new Set((kept.whole?.result.failed ?? []).filter((failure) => failure.final === true).map((failure) => failure.key));
      const gaps = manifestGaps(here, answer.body, { sent: kept.sent, removed, skip: refused });
      if (!gaps) throw new CloudSendError("unreachable", "My Cloud did not say what it has. Try again.");
      const bots = new Set((here.items ?? []).filter((item) => item.kind === "bot" && !removed.has(item.key) && !refused.has(item.key)).map((item) => item.id));
      const going = roomsThatGo(here, bots);
      const threads = (here.conversations ?? []).filter((head) => !removed.has(head.threadId)
        && (head.room ? going.has(head.room) && !removed.has(`room:${head.room}`) : bots.has(head.bot))).map((head) => head.threadId);
      const chats = await checkChats({ localJson, session, threads });
      const attachments = await missingAttachments(session, Array.isArray(here.attachments) ? here.attachments : []);
      const secrets = team ? { equal: [], differs: [], missing: [] } : await checkSecrets({ handoff, session, skip: new Set([...removed, ...refused]) });
      return { ok: checkPassed({ gaps, chats, attachments, secrets }), gaps, chats, attachments, secrets };
    } finally {
      try { await session.close(); } catch {}
    }
  }

  return {
    snapshot,
    compare,
    send,
    check,
    /** The per-item switch. Turning on something removed on My Cloud forgets that it was sent, so it goes again. */
    setItem(key, on) {
      const origin = cloud.origin();
      if (!origin || typeof key !== "string") return publish();
      const kept = entry(origin);
      if (on) {
        if (kept.off[key] === "removed") delete kept.sent[key];
        delete kept.off[key];
      } else kept.off[key] = "you";
      persist();
      if (view.local && view.theirs) view = { ...view, plan: plan(origin, view.local, view.theirs) };
      return publish();
    },
    dismiss(signature) {
      const origin = cloud.origin();
      if (origin && typeof signature === "string") { entry(origin).dismissed = signature.slice(0, 20_000); persist(); }
      return publish();
    },
    /** Each automation a move carried, by key, and whether it was on here when it went: what the switch turns on there. */
    switches() {
      const origin = cloud.origin();
      return origin ? { ...entry(origin).on } : {};
    },
    /** For the native menu: what is waiting, from the last comparison, without asking anyone. */
    waiting() {
      const plan = view.plan;
      if (!plan || view.cloud !== "ready") return null;
      const rows = pendingRows(plan);
      return { bots: rows.filter((row) => row.kind === "bot" && row.state === "only-here").length, total: rows.length };
    },
  };
}
