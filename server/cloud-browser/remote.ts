// The Cloud's browser sandbox at the provider: one small sandbox per personal Cloud home, made the first time a bot needs
// a browser, shared by that Cloud's bots, each with a profile and a Chrome of its own on its disk. It is not a bot's cloud
// computer: no bot runs commands in it, the computer screens never list it, and it exists only through MausBot Cloud's
// Admin relay, which keeps it out of the plan's computers and hours under limits of its own, and runs in it only the
// fixed browser actions it builds itself (launch, quit). A person's own provider key never gets one.
// Woken with ONE resume and then only reads, never the resume loop of boat.ts's waitReady: a refused resume is billed.
import { createHash } from "node:crypto";

import { boatAccount, boatFetch, boatNameFor, boatRefusal, deadBoatOf, findBoat, requestRecordedBoatDeletion, SLEEPING_BOAT_STATES } from "../boat.ts";
import { beginBoatCreate, discardBoatCreate, rememberCreatedBoat, resolveBoatCreate } from "../boat-create-idempotency.ts";
import { relayBody } from "../boat-relay.ts";
import { copyFromComputer, copyToComputer, readFromComputerInline, writeToComputerInline, type CopyOutcome } from "../cloud-computer-files.ts";
import type { AppConfig } from "../config.ts";

const READY = new Set(["idle", "ready", "running"]);
const TERMINAL = new Set(["error", "cancelled"]);
/** The sandbox's owner key: its name is `ogb-<this installation>-browser-<hash>`, so operators tell it from a bot's computer. */
export const BROWSER_SANDBOX_OWNER = "browser";
/** Chromes at once in one sandbox (one per bot browsing) until the relay says how many this Cloud's size takes (two on
 * `small`, where one heavy page measured 954 MB of 4 GB; three on `default`); past it a bot's browser opens in the home. The
 * Admin's launch also refuses a Chrome when under 1 GiB is free. */
export const BROWSER_SANDBOX_CHROMES = 2;
/** The port the sandbox's small door listens on, on its loopback only; the provider's relay reaches it there. */
export const COMPUTER_DOOR_PORT = 39231;

/** A bot's folder name in the sandbox: a hash, so the sandbox never holds a bot's id or name. */
export const profileKey = (botId: string): string => createHash("sha256").update(`omb-browser:${botId}`).digest("hex").slice(0, 16);

/** What the relay says before anything is started: whether a browser sandbox may start now, and until when it may not. */
export type Availability =
  | { kind: "old-relay" }
  | { kind: "available"; boxId: string | null; chromes: number | null; caps: { resumes: number | null; awakeMinutes: number | null } }
  | { kind: "unavailable"; reason: string; resetsAt: string | null };

/** What the browser needs from the relay; tests pass their own. */
export interface ComputerOps {
  /** The relay's word on the browser sandbox; an Admin from before it answers 404 ("old-relay"). */
  probe(): Promise<Availability>;
  /** The Cloud's browser sandbox, or null when there is none yet. */
  find(): Promise<{ id: string; state: string } | null>;
  /** A sandbox the provider reports broken (`error`), which never runs again, or null. */
  dead(): string | null;
  /** Makes it (once: the create is journaled under one idempotency key) and names it. Throws the relay's refusal. */
  create(): Promise<{ id: string; state: string }>;
  /** One resume. Throws SandboxGone when the relay says this sandbox can never resume, else the relay's refusal (with its
   * limit) on anything but a 2xx or a 409. */
  resume(boxId: string): Promise<void>;
  state(boxId: string): Promise<string | null>;
  /** One bot's Chrome started on its profile, with this open's door secret; `home` is the sandbox's home folder. */
  /** `policy`: the Chrome policy that blocks file:// and Chrome's own pages could be written in the sandbox. */
  launch(boxId: string, key: string, secret: string): Promise<{ chrome: boolean; home: string | null; policy: boolean }>;
  /** A finished download (a sandbox path) brought into `folder` as `to`, with the cloud computers' copy checks and limits.
   * A sandbox that takes no direct connections is copied from through the provider's JSON file read (at most 5 MiB). */
  fetchFile(boxId: string, path: string, folder: string, to: string): Promise<CopyOutcome>;
  /** A file of the Cloud (`from`, inside `folder`) copied to a sandbox path for an upload; likewise through the JSON file write. */
  sendFile(boxId: string, folder: string, from: string, path: string): Promise<CopyOutcome>;
  /** A deleted bot's profile, door secret and files in the sandbox, erased. */
  erase(boxId: string, key: string): Promise<void>;
  /** A download the sandbox no longer needs to keep. */
  removeDownload(boxId: string, key: string, name: string): Promise<void>;
  /** One bot's Chrome asked to quit (it writes its cookies); `key` null: every Chrome and the door. */
  quit(boxId: string, key: string | null): Promise<void>;
  /** The door's port on a protected relay URL (one that needs its token); null where it is refused or unprotected. */
  host(boxId: string, port: number): Promise<string | null>;
  /** Moves the provider's own auto-stop to now + `seconds`, so it stops the sandbox only after that long unused: "moved",
   * "refused" (the Admin's maximum session age: the deadline is left to run out on purpose) or "failed" (to try again soon). */
  refreshTtl(boxId: string, seconds: number): Promise<"moved" | "refused" | "failed">;
  /** Deletes it, journaled like every deletion (boat-delete-journal.ts), so a failed delete is retried and never leaks. */
  remove(boxId: string): Promise<boolean>;
}

async function json(cfg: AppConfig, path: string, init: RequestInit = {}) {
  const res = await boatFetch(cfg, path, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const body: any = relayBody(boatAccount(cfg), await res.json().catch(() => null));
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

/** `purpose` tells the Admin's relay this is the Cloud's browser sandbox, outside the plan's computers and hours. Its size
 * is the Admin's to choose by the Cloud's plan (small, or default on the bigger plans), so none is asked for here. */
export const browserSandboxCreateBody = () => ({ noEnv: true, purpose: "browser" });

/** The Cloud's relay does not know the browser sandbox (an Admin from before it): nothing is created. */
export class OldRelay extends Error {}

const HEX16 = /^[a-f0-9]{16}$/, HEX48 = /^[a-f0-9]{48}$/;

/** The relay URL only when it is protected: it carries the access token the relay checks. */
function protectedUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try { return new URL(raw).searchParams.get("_token") ? raw : null; } catch { return null; }
}

export function providerOps(cfg: () => AppConfig): ComputerOps {
  async function create(): Promise<{ id: string; state: string }> {
    const config = cfg();
    const body = JSON.stringify(browserSandboxCreateBody());
    let request = beginBoatCreate(BROWSER_SANDBOX_OWNER, body).request;
    let answer = request.boxId ? await json(config, `/sandboxes/${request.boxId}`) : null;
    // A remembered sandbox proven gone frees its key: never create again under it, which could return the gone one.
    if (request.boxId && (answer?.status === 404 || answer?.status === 410)) {
      discardBoatCreate(request);
      request = beginBoatCreate(BROWSER_SANDBOX_OWNER, body).request;
      answer = null;
    }
    let posted = false;
    if (!answer?.ok) {
      posted = true;
      answer = await json(config, "/sandboxes", { method: "POST", headers: { "Idempotency-Key": request.idempotencyKey }, body, signal: AbortSignal.timeout(45_000) });
      // The relay already holds this Cloud's live browser sandbox (a create whose answer was lost): that one is ours.
      const existing = answer.body?.boxId ?? answer.body?.error?.boxId;
      if (answer.status === 409 && (answer.body?.code ?? answer.body?.error?.code) === "browser_sandbox_exists" && typeof existing === "string") {
        answer = { ok: true, status: 200, body: { sandbox: { id: existing, state: "unknown" } } };
        posted = false;
      }
    }
    const boxId = answer.body?.sandbox?.id;
    if (!answer.ok || typeof boxId !== "string") {
      if (answer.status < 500 && answer.status !== 409) discardBoatCreate(request);
      throw boatRefusal(answer.status, "making the browser sandbox", answer.body, true);
    }
    request = rememberCreatedBoat(request, boxId);
    // Checked before anything is created too (probe); this is the last guard: a box the relay did not mark is deleted at once.
    if (posted && answer.body.sandbox.purpose !== "browser") {
      resolveBoatCreate(request);
      await requestRecordedBoatDeletion(config, { boxId, name: await boatNameFor(BROWSER_SANDBOX_OWNER), ownerBotId: BROWSER_SANDBOX_OWNER }).catch(() => "pending");
      throw new OldRelay();
    }
    const named = await json(config, `/sandboxes/${boxId}`, { method: "PATCH", body: JSON.stringify({ name: await boatNameFor(BROWSER_SANDBOX_OWNER) }) });
    if (!named.ok) throw boatRefusal(named.status, "naming the browser sandbox", named.body, true);
    resolveBoatCreate(request);
    return { id: boxId, state: typeof answer.body.sandbox.state === "string" ? answer.body.sandbox.state : "unknown" };
  }
  const action = async (boxId: string, body: Record<string, unknown>) => {
    const answer = await json(cfg(), `/sandboxes/${boxId}/browser`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) throw boatRefusal(answer.status, "the browser sandbox's browser", answer.body, true);
    return answer.body;
  };
  return {
    async probe() {
      const answer = await json(cfg(), "/browser-sandbox");
      // An Admin from before the browser sandbox answers its unknown route with 404, or 403 `not_available`.
      if (answer.status === 404 || (answer.status === 403 && (answer.body?.code ?? answer.body?.error?.code) === "not_available")) return { kind: "old-relay" };
      if (!answer.ok || typeof answer.body?.available !== "boolean") throw boatRefusal(answer.status, "asking about the browser sandbox", answer.body, true);
      const chromes = Number.isInteger(answer.body.chromes) && answer.body.chromes >= 1 && answer.body.chromes <= 4 ? answer.body.chromes as number : null;
      const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
      const caps = { resumes: count(answer.body.caps?.resumesPerDay), awakeMinutes: count(answer.body.caps?.awakeMinutesPerDay) };
      if (answer.body.available) return { kind: "available", boxId: typeof answer.body.boxId === "string" ? answer.body.boxId : null, chromes, caps };
      return { kind: "unavailable", reason: typeof answer.body.reason === "string" ? answer.body.reason : "unknown", resetsAt: typeof answer.body.resetsAt === "string" ? answer.body.resetsAt : null };
    },
    async find() {
      const found = await findBoat(cfg(), BROWSER_SANDBOX_OWNER);
      return found && typeof found.id === "string" ? { id: found.id, state: typeof found.state === "string" ? found.state : "unknown" } : null;
    },
    dead: () => deadBoatOf(BROWSER_SANDBOX_OWNER)?.boxId ?? null,
    create,
    async resume(boxId) {
      const answer = await json(cfg(), `/sandboxes/${boxId}/resume`, { method: "POST" });
      if (sandboxGone(answer.status, answer.body)) throw new SandboxGone();
      // 409: a wake already under way; it is waited for like this one.
      if (!answer.ok && answer.status !== 409) throw boatRefusal(answer.status, "waking the browser sandbox", answer.body, true);
    },
    async state(boxId) {
      const answer = await json(cfg(), `/sandboxes/${boxId}`);
      const state = answer.body?.sandbox?.state;
      return typeof state === "string" ? state : null;
    },
    async launch(boxId, key, secret) {
      if (!HEX16.test(key) || !HEX48.test(secret)) throw new Error("bad browser profile key or door secret");
      const answer = await action(boxId, { action: "launch", key, secret });
      const home = typeof answer?.home === "string" && /^\/[^\0\n]*$/.test(answer.home) && !answer.home.split("/").includes("..") ? answer.home.replace(/\/+$/, "") : null;
      return { chrome: answer?.chrome === true, home, policy: answer?.policy === true };
    },
    // The link first, as on every sandbox before: on one that takes no direct connections the relay answers its 409
    // `inbound_closed` itself, without asking the provider, and the JSON file call goes instead.
    async fetchFile(boxId, path, folder, to) {
      const signal = AbortSignal.timeout(10 * 60_000);
      const linked = await copyFromComputer(cfg(), boxId, folder, { path, to }, signal);
      return "error" in linked && linked.inboundClosed ? readFromComputerInline(cfg(), boxId, folder, { path, to }, signal) : linked;
    },
    async sendFile(boxId, folder, from, path) {
      const signal = AbortSignal.timeout(10 * 60_000);
      const linked = await copyToComputer(cfg(), boxId, folder, { from, path }, signal);
      return "error" in linked && linked.inboundClosed ? writeToComputerInline(cfg(), boxId, folder, { from, path }, signal) : linked;
    },
    async erase(boxId, key) {
      if (!HEX16.test(key)) throw new Error("bad browser profile key");
      await action(boxId, { action: "erase", key });
    },
    async removeDownload(boxId, key, name) {
      if (!HEX16.test(key)) throw new Error("bad browser profile key");
      await action(boxId, { action: "remove-download", key, name });
    },
    async quit(boxId, key) {
      if (key !== null && !HEX16.test(key)) throw new Error("bad browser profile key");
      await action(boxId, key === null ? { action: "quit-all" } : { action: "quit", key });
    },
    async host(boxId, port) {
      const answer = await json(cfg(), `/sandboxes/${boxId}/host`, { method: "POST", body: JSON.stringify({ port, localhost: true }) });
      if (!answer.ok || answer.body?.isProtected === false || answer.body?.access === "public") return null;
      return protectedUrl(answer.body?.url);
    },
    async refreshTtl(boxId, seconds) {
      const answer = await json(cfg(), `/sandboxes/${boxId}`, { method: "PATCH", body: JSON.stringify({ ttlSeconds: ttlSecondsOf(seconds) }) }).catch(() => null);
      if (answer?.ok) return "moved";
      return answer?.status === 409 && (answer.body?.code ?? answer.body?.error?.code) === "max_age" ? "refused" : "failed";
    },
    async remove(boxId) {
      const name = await boatNameFor(BROWSER_SANDBOX_OWNER);
      return (await requestRecordedBoatDeletion(cfg(), { boxId, name, ownerBotId: BROWSER_SANDBOX_OWNER })) === "confirmed";
    },
  };
}

/** The provider silently takes a ttlSeconds that is not a number as an hour: only a whole number within the Admin's range goes. */
export const ttlSecondsOf = (seconds: number): number => Math.min(1_800, Math.max(300, Math.round(Number.isFinite(seconds) ? seconds : 300)));

/** The relay's word that a sandbox can never be resumed (one that keeps nothing after a stop): `410` with the code
 * `browser_sandbox_gone`. Every other answer to a resume is what it was. */
export const SANDBOX_GONE_CODE = "browser_sandbox_gone";
export const sandboxGone = (status: number, body: any): boolean => status === 410 && (body?.code ?? body?.error?.code) === SANDBOX_GONE_CODE;

/** The sandbox can never resume: it is deleted and a fresh one made at once, under the start already counted for it. Not a
 * failure: nothing is held off for it. */
export class SandboxGone extends Error {}

/** Not a failure of the sandbox: the browser opens in the home, and nothing is counted against it. */
export class StaysHome extends Error {
  readonly reason: "busy" | "budget";
  constructor(reason: "busy" | "budget") {
    super(reason);
    this.reason = reason;
  }
}

export interface WakeOptions {
  /** Asked before the one start (a create or a resume) is sent: false keeps it unsent (the day's budget, a hold). */
  mayStart(): boolean;
  /** The relay's word, asked once before a start: what it says decides whether one is sent at all. */
  allowed(): Promise<void>;
  /** Called just before the start goes out, so it counts whatever the answer. */
  starting(): void;
  budgetMs?: number;
  pollMs?: number;
}

/** The sandbox ready to take actions: made or woken with at most one start, then read until it says so. A sandbox the
 * provider reports broken is deleted first and a fresh one made, counted like any start. */
export async function wakeSandbox(ops: ComputerOps, options: WakeOptions): Promise<{ id: string; started: boolean }> {
  let found = await ops.find();
  if (found && READY.has(found.state)) return { id: found.id, started: false };
  const broken = found && TERMINAL.has(found.state) ? found.id : found ? null : ops.dead();
  if (broken) {
    await ops.remove(broken);
    found = null;
  }
  /** A sandbox the relay says can never resume goes the broken one's way: deleted, and a fresh one made. */
  const replaced = async (gone: string): Promise<{ id: string; state: string }> => {
    await ops.remove(gone);
    return ops.create();
  };
  const counted = async (box: { id: string; state: string } | null): Promise<{ id: string; state: string }> => {
    if (!options.mayStart()) throw new StaysHome("budget");
    await options.allowed();
    options.starting();
    if (!box) return ops.create();
    try {
      await ops.resume(box.id);
    } catch (error) {
      if (!(error instanceof SandboxGone)) throw error;
      // Its resume started nothing: the create is the one start counted above.
      return replaced(box.id);
    }
    return box;
  };
  let started = false;
  /** Taken back while still stopping: the same machine, ready in about 0.3 s, and no start (measured). Only the home asks
   * for a browser, so a stop the Admin made because the home was down is never undone by this; the newest request wins. */
  let takenBack = false;
  if (found?.state === "archiving") {
    try {
      await ops.resume(found.id);
      takenBack = true;
    } catch (error) {
      if (!(error instanceof SandboxGone)) throw error;
      // A take-back counts no start, but the create that replaces it is one.
      await ops.remove(found.id);
      found = await counted(null);
    }
    started = true;
  } else if (!found || SLEEPING_BOAT_STATES.has(found.state)) {
    found = await counted(found);
    started = true;
  }
  let id = found!.id;
  const deadline = Date.now() + (options.budgetMs ?? 45_000);
  // Quick reads first: a resume after a short stop is ready in well under a second.
  for (let reads = 0; Date.now() < deadline; reads++) {
    await new Promise((resolve) => setTimeout(resolve, reads < 12 ? Math.min(250, options.pollMs ?? 250) : options.pollMs ?? 1_000));
    const state = await ops.state(id).catch(() => null);
    if (state && READY.has(state)) return { id, started };
    if (state && TERMINAL.has(state)) break;
    // The take-back came too late (the machine went with the stop): one real, counted resume instead.
    if (takenBack && state === "archived") { takenBack = false; id = (await counted({ id, state })).id; }
    // Never a second start: a refused resume is billed as one too.
  }
  throw new Error("the browser sandbox did not become ready in time");
}
