// A Team Cloud tells people what happened while they were away: a teammate mentioned them, a bot waits on their answer,
// work they asked for finished. The Admin owns their addresses and sends the email (openmaus-cloud docs/team-cloud.md
// "When you are away"); this machine decides what is worth one and asks for it with a signed call.
// Security invariants: what leaves here is names and opaque hashes, never a message's words, a conversation's title or
// an id; an item from someone's private chat names no bot and no place. The Admin checks every address against the
// team's own roster itself.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import type { SessionRecord } from "../sessions.ts";

/** On the Admin; must match openmaus-cloud's TEAM_AWAY_MACHINE_PATH. */
export const TEAM_AWAY_ADMIN_PATH = "/api/cloud/machines/team-away";
/** The person's own switch: `GET` → `{ on }`, `PUT { on }` → `{ on }`. A Team Cloud session only. */
export const AWAY_EMAILS_PATH = "/api/me/away-emails";
/** The first thing that happens while someone is away opens a window; what happens in it goes in the same email. */
export const AWAY_WINDOW_MS = 10 * 60_000;
/** A question waits at least this long unanswered before an email tells of it. */
export const AWAY_ASK_MIN_MS = 5 * 60_000;
export const AWAY_GAP_MS = 30 * 60_000;
export const AWAY_DAILY_MAX = 6;
/** Finished work is told once per conversation for a stretch of absence; a stretch this long ends by itself. */
export const AWAY_STRETCH_MS = 12 * 60 * 60_000;
export const AWAY_ITEMS_MAX = 10;
export const AWAY_EMAILS_FILE = "away-emails.json";
const DAY_MS = 24 * 60 * 60_000;
const KEYS_KEEP_MS = 7 * DAY_MS;
const KEYS_MAX = 5_000;
const RETRY_MS = [60_000, 5 * 60_000];
const UNAVAILABLE_MS = 60 * 60_000;
const REFRESH_GAP_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const ANSWER_MAX_BYTES = 64 * 1024;
const PERSON = /^p_[\w-]{22}$/u;

export type AwayKind = "mention" | "waiting" | "finished" | "failed";

/** One line of an away email, exactly as the Admin receives it. */
export interface AwayItem {
  kind: AwayKind;
  /** 64 hex digits: the SHA-256 of what it is about here, so the same thing is never emailed twice. */
  key: string;
  /** The teammate or bot who did it. On a private item only a teammate who wrote to the person. */
  who?: string;
  /** A shared place's name: the group chat's, or the bot's whose shared chat it is. Never on a private item. */
  place?: string;
  routine?: true;
  /** It happened in someone's private chat: the email says only what kind of thing it was. */
  private?: true;
}
/** One email for one person. `id` makes a retry the same email. */
export interface AwayNotice { id: string; to: string; language?: string; items: AwayItem[]; more?: number }
/** `POST /api/cloud/machines/team-away`, signed with the bootstrap secret (`teamAwaySignature`). `prefs` carries the
 * person's own switch, changed in the app, until the Admin has it. */
export interface AwayRequest { v: 1; notices: AwayNotice[]; prefs?: { to: string; on: boolean }[] }

const answerSchema = z.object({
  v: z.literal(1),
  results: z.array(z.object({ id: z.string(), state: z.string() })).max(50),
  off: z.array(z.string().max(320)).max(1_000).optional(),
});

/** Must match openmaus-cloud's teamAwaySignature. */
export function teamAwaySignature(secret: string, machineId: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`omb-team-away-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

export const awayKey = (about: string): string => createHash("sha256").update(`omb-team-away\n${about}`).digest("hex");

/** Something that happened for one person. `about` is what makes it the same thing twice; only its hash leaves. */
export interface AwayEvent {
  person: string;
  item: Omit<AwayItem, "key">;
  about: string;
  /** Finished work: its conversation, told once per stretch of absence, and left out of an email that already has a
   * question or a mention from there. */
  conversation?: string;
  /** A question or a mention: the conversation it came from. */
  thread?: string;
  /** Asked again when the email goes: false once it was answered, seen or closed. */
  still?: () => boolean;
}

interface Pending { key: string; at: number; item: AwayItem; conversation?: string; thread?: string; still?: () => boolean }
interface Timer { unref?(): unknown }

export interface TeamAwayDeps {
  /** Whether the person has the team open now. The one place that decides "away". */
  here(person: string): boolean;
  /** A current member by person key; undefined for someone who left or was never in. */
  member(person: string): { email: string } | undefined;
  /** The language their app shows, when the server knows it. */
  language(person: string): string | undefined;
  dataDir: string;
  adminOrigin: string;
  machineId: string;
  secret: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** AWAY_WINDOW_MS unless a fixture shortens it; a question's wait shortens with it. */
  windowMs?: number;
}

const prefSchema = z.object({ version: z.literal(1), on: z.boolean(), synced: z.boolean() });
type Pref = z.infer<typeof prefSchema>;

export function createTeamAway(deps: TeamAwayDeps) {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  const fetcher = deps.fetchImpl ?? globalThis.fetch;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const windowMs = deps.windowMs ?? AWAY_WINDOW_MS, askMinMs = Math.min(AWAY_ASK_MIN_MS, windowMs / 2);
  const pending = new Map<string, Pending[]>();
  const timers = new Map<string, Timer>();
  const sentKeys = new Map<string, number>();
  const sentAt = new Map<string, number[]>();
  const stretches = new Map<string, { since: number; told: Set<string> }>();
  const retries = new Map<string, { notice: AwayNotice; items: Pending[]; tries: number }>();
  let unavailableUntil = 0, stopped = false, lastRefresh = 0;
  let syncTimer: Timer | null = null;

  const prefPath = (person: string) => join(deps.dataDir, "people", person, AWAY_EMAILS_FILE);
  const readPref = (person: string): Pref | null => {
    if (!PERSON.test(person)) return null;
    try {
      const parsed = prefSchema.safeParse(JSON.parse(readFileSync(prefPath(person), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  };
  const writePref = (person: string, pref: Pref | null) => {
    if (!PERSON.test(person)) return;
    try {
      if (!pref || (pref.on && pref.synced)) { rmSync(prefPath(person), { force: true }); return; }
      mkdirSync(join(deps.dataDir, "people", person), { recursive: true, mode: 0o700 });
      writeFileAtomic(prefPath(person), `${JSON.stringify(pref)}\n`, { mode: 0o600 });
    } catch (error) {
      log(`away emails: could not keep a switch: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  };
  const isOn = (person: string) => readPref(person)?.on ?? true;
  const unsynced = (): { person: string; to: string; on: boolean }[] => {
    let people: string[] = [];
    try { people = readdirSync(join(deps.dataDir, "people")).filter((one) => PERSON.test(one)); } catch { return []; }
    return people.flatMap((person) => {
      const pref = readPref(person), member = pref && !pref.synced ? deps.member(person) : undefined;
      return pref && member ? [{ person, to: member.email, on: pref.on }] : [];
    });
  };

  const here = (person: string): boolean => {
    try { return deps.here(person); } catch { return true; }
  };
  const forget = (person: string) => {
    const timer = timers.get(person);
    if (timer) clearTimer(timer);
    timers.delete(person);
    pending.delete(person);
    retries.delete(person);
    stretches.delete(person);
  };
  const stretchOf = (person: string) => {
    const known = stretches.get(person);
    if (known && now() - known.since < AWAY_STRETCH_MS) return known;
    const fresh = { since: now(), told: new Set<string>() };
    stretches.set(person, fresh);
    return fresh;
  };
  const recentSends = (person: string) => (sentAt.get(person) ?? []).filter((at) => now() - at < DAY_MS);
  const remember = (keys: string[]) => {
    for (const [key, at] of sentKeys) if (now() - at >= KEYS_KEEP_MS) sentKeys.delete(key);
    for (const key of keys) sentKeys.set(key, now());
    while (sentKeys.size > KEYS_MAX) sentKeys.delete(sentKeys.keys().next().value!);
  };

  const schedule = (person: string, at?: number) => {
    if (stopped || timers.has(person)) return;
    const queue = pending.get(person) ?? [];
    const retry = retries.get(person);
    if (!queue.length && !retry) return;
    const last = recentSends(person).at(-1);
    const due = at ?? Math.max(Math.min(...queue.map((one) => one.at)) + windowMs, last !== undefined ? last + AWAY_GAP_MS : 0);
    const timer = setTimer(() => { timers.delete(person); void flush(person); }, Math.max(0, due - now()));
    timer.unref?.();
    timers.set(person, timer);
  };

  function noticed(event: AwayEvent): void {
    const { person } = event;
    if (stopped || !deps.member(person)) return;
    if (here(person)) { forget(person); return; }
    if (!isOn(person)) return;
    const key = awayKey(event.about);
    const queue = pending.get(person) ?? [];
    if (sentKeys.has(key) || queue.some((one) => one.key === key)) return;
    if (event.conversation && (stretchOf(person).told.has(event.conversation) || queue.some((one) => one.conversation === event.conversation))) return;
    queue.push({ key, at: now(), item: { ...event.item, key }, ...(event.conversation ? { conversation: event.conversation } : {}), ...(event.thread ? { thread: event.thread } : {}), ...(event.still ? { still: event.still } : {}) });
    pending.set(person, queue);
    schedule(person);
  }

  const signedPost = async (request: AwayRequest): Promise<{ status: number; answer: z.infer<typeof answerSchema> | null }> => {
    const body = JSON.stringify(request);
    const timestamp = String(Math.floor(now() / 1000)), nonce = randomBytes(18).toString("base64url");
    const response = await fetcher(`${deps.adminOrigin}${TEAM_AWAY_ADMIN_PATH}`, { method: "POST", redirect: "error", cache: "no-store", body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: {
      accept: "application/json", "content-type": "application/json", "x-omb-cloud-machine": deps.machineId, "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${teamAwaySignature(deps.secret, deps.machineId, timestamp, nonce, body)}`,
    } });
    const json = /^application\/json\b/i.test(response.headers.get("content-type") ?? "");
    if (response.status !== 200 || !json) { await response.body?.cancel().catch(() => {}); return { status: response.status, answer: null }; }
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try { parsed = text.length > ANSWER_MAX_BYTES ? null : JSON.parse(text); } catch { parsed = null; }
    const answer = answerSchema.safeParse(parsed);
    return { status: answer.success ? 200 : 502, answer: answer.success ? answer.data : null };
  };

  /** One call: what is to send, the switches not yet told, and what the Admin says is off. */
  const call = async (notices: AwayNotice[]): Promise<{ status: number; states: Map<string, string> }> => {
    const prefs = unsynced();
    if (now() < unavailableUntil) return { status: 404, states: new Map() };
    let result: Awaited<ReturnType<typeof signedPost>>;
    try {
      result = await signedPost({ v: 1, notices, ...(prefs.length ? { prefs: prefs.map(({ to, on }) => ({ to, on })) } : {}) });
    } catch (error) {
      log(`away emails: the Admin can't be reached (${error instanceof Error ? error.name : "error"})`);
      return { status: 0, states: new Map() };
    }
    if (result.status === 404) { unavailableUntil = now() + UNAVAILABLE_MS; return { status: 404, states: new Map() }; }
    if (!result.answer) { log(`away emails: the Admin answered HTTP ${result.status}`); return { status: result.status, states: new Map() }; }
    for (const { person, on } of prefs) {
      const pref = readPref(person);
      if (pref && pref.on === on && !pref.synced) writePref(person, { version: 1, on, synced: true });
    }
    for (const address of result.answer.off ?? []) {
      const person = personKey({ id: "", email: address });
      if (deps.member(person) && readPref(person)?.synced !== false) writePref(person, { version: 1, on: false, synced: true });
    }
    return { status: 200, states: new Map(result.answer.results.map(({ id, state }) => [id, state])) };
  };

  async function flush(person: string): Promise<void> {
    if (stopped) return;
    const member = deps.member(person);
    if (!member || here(person) || !isOn(person)) { forget(person); return; }
    const retry = retries.get(person);
    let notice: AwayNotice, items: Pending[], tries: number;
    if (retry) {
      retries.delete(person);
      ({ notice, items, tries } = retry);
    } else {
      const queue = pending.get(person) ?? [];
      const ready = queue.filter((one) => now() - one.at >= (one.item.kind === "waiting" ? askMinMs : 0));
      pending.set(person, queue.filter((one) => !ready.includes(one)));
      items = ready.filter((one) => !sentKeys.has(one.key) && (one.still?.() ?? true));
      tries = 0;
      if (!items.length || recentSends(person).length >= AWAY_DAILY_MAX) { schedule(person); return; }
      const covered = new Set(items.flatMap((one) => (one.thread ? [one.thread] : [])));
      const ranked = items.filter((one) => !one.conversation || !covered.has(one.conversation)).sort((a, b) => RANK[a.item.kind] - RANK[b.item.kind] || a.at - b.at);
      const language = deps.language(person);
      notice = { id: `n_${randomBytes(16).toString("base64url")}`, to: member.email, ...(language ? { language } : {}), items: ranked.slice(0, AWAY_ITEMS_MAX).map((one) => one.item),
        ...(ranked.length > AWAY_ITEMS_MAX ? { more: ranked.length - AWAY_ITEMS_MAX } : {}) };
    }
    const { status, states } = await call([notice]);
    if (stopped) return;
    const state = states.get(notice.id);
    if (status === 200 && state) {
      remember(items.map((one) => one.key));
      if (state === "sent") {
        sentAt.set(person, [...recentSends(person), now()]);
        const stretch = stretchOf(person);
        for (const one of items) if (one.conversation) stretch.told.add(one.conversation);
      }
      if (state === "off") writePref(person, { version: 1, on: false, synced: true });
    } else if ((status === 0 || status >= 500) && tries < RETRY_MS.length) {
      retries.set(person, { notice, items, tries: tries + 1 });
      schedule(person, now() + RETRY_MS[tries]!);
      return;
    }
    schedule(person);
  }

  const syncSoon = () => {
    if (stopped || syncTimer) return;
    syncTimer = setTimer(() => { syncTimer = null; void call([]); }, 2_000);
    syncTimer.unref?.();
  };

  const routes: (session: (auth: RequestAuth) => SessionRecord | null) => RouteHandler = (session) => async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== AWAY_EMAILS_PATH) return PASS;
    const signedIn = session(auth);
    if (!signedIn?.email) return json(res, 403, { error: "Sign in to this team to choose your emails." });
    const person = personKey(signedIn);
    if (method === "GET") {
      if (now() - lastRefresh >= REFRESH_GAP_MS) {
        lastRefresh = now();
        await Promise.race([call([]), new Promise((resolve) => { const timer = setTimer(() => resolve(null), 3_000); timer.unref?.(); })]);
      }
      return json(res, 200, { on: isOn(person) });
    }
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, 1024);
    const on = body && typeof body === "object" ? (body as { on?: unknown }).on : undefined;
    if (typeof on !== "boolean") return json(res, 400, { error: "send { on: true } or { on: false }" });
    writePref(person, { version: 1, on, synced: false });
    if (!on) forget(person);
    syncSoon();
    return json(res, 200, { on });
  };

  return {
    noticed,
    routes,
    /** Runs every person's timer now, as if each were due. */
    async runTimers(): Promise<void> {
      for (const person of new Set([...pending.keys(), ...retries.keys()])) {
        const timer = timers.get(person);
        if (timer) clearTimer(timer);
        timers.delete(person);
        await flush(person);
      }
    },
    pendingFor: (person: string): readonly AwayItem[] => (pending.get(person) ?? []).map((one) => one.item),
    stop(): void {
      stopped = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      if (syncTimer) clearTimer(syncTimer);
    },
  };
}

const RANK: Record<AwayKind, number> = { waiting: 0, mention: 1, failed: 2, finished: 3 };

export type TeamAway = ReturnType<typeof createTeamAway>;
