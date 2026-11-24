// The Cloud's browser sandbox at the provider: one small sandbox per personal Cloud home, made the first time a bot needs
// a browser, shared by that Cloud's bots, each with a profile of its own on its disk. It is not a bot's cloud computer:
// no bot runs commands in it, the computer screens never list it, and on MausBot Cloud the Admin's relay keeps it out of
// the plan's computers and hours (`purpose: "browser"`) under limits of its own.
// Woken with ONE resume and then only reads, never the resume loop of boat.ts's waitReady: a refused resume is billed.
import { createHash } from "node:crypto";

import { boatAccount, boatFetch, boatNameFor, boatRefusal, findBoat, requestRecordedBoatDeletion, runCommand, SLEEPING_BOAT_STATES } from "../boat.ts";
import { beginBoatCreate, discardBoatCreate, rememberCreatedBoat, resolveBoatCreate } from "../boat-create-idempotency.ts";
import { relayBody } from "../boat-relay.ts";
import type { CommandOutcome } from "../boat-command.ts";
import type { AppConfig } from "../config.ts";

const READY = new Set(["idle", "ready", "running"]);
const TERMINAL = new Set(["error", "cancelled"]);
/** The sandbox's owner key: its name is `ogb-<this installation>-browser-<hash>`, so operators tell it from a bot's computer. */
export const BROWSER_SANDBOX_OWNER = "browser";
/** The provider's smallest size that runs Chrome well: 2 vCPU, 4 GB. A heavy page measured 0.8–0.87 GB per Chrome. */
export const BROWSER_SANDBOX_TYPE = "small";
/** Chromes at once in one sandbox (one per bot browsing); past this a bot's browser opens in the home. */
export const BROWSER_SANDBOX_CHROMES = 3;
/** The provider stops it by itself after this long if every stop path here died. */
const BROWSER_SANDBOX_TTL_SECONDS = 2 * 60 * 60;
/** The port the sandbox's small door listens on, on its loopback only; the provider's relay reaches it there. */
export const COMPUTER_DOOR_PORT = 39231;
/** Where the browsers keep their profiles and the door on the sandbox's disk. */
export const COMPUTER_BROWSER_DIR = "$HOME/.omb-browser";

/** A bot's folder name in the sandbox: a hash, so the sandbox never holds a bot's id or name. */
export const profileKey = (botId: string): string => createHash("sha256").update(`omb-browser:${botId}`).digest("hex").slice(0, 16);

/** What the browser needs from the provider; tests pass their own. */
export interface ComputerOps {
  /** The Cloud's browser sandbox, or null when there is none yet. */
  find(): Promise<{ id: string; state: string } | null>;
  /** Makes it (once: the create is journaled under one idempotency key) and names it. Throws the provider's or the Admin's refusal. */
  create(): Promise<{ id: string; state: string }>;
  /** One resume. Throws the provider's or the Admin's refusal (with its limit) on anything but a 2xx or a 409. */
  resume(boxId: string): Promise<void>;
  state(boxId: string): Promise<string | null>;
  run(boxId: string, command: string, timeoutMs: number): Promise<CommandOutcome>;
  /** The provider's way to put the door's port on a URL; null where it is refused. */
  host(boxId: string, port: number): Promise<string | null>;
  /** Deletes it, journaled like every deletion (boat-delete-journal.ts), so a failed delete is retried and never leaks. */
  remove(boxId: string): Promise<boolean>;
}

async function json(cfg: AppConfig, path: string, init: RequestInit = {}) {
  const res = await boatFetch(cfg, path, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const body: any = relayBody(boatAccount(cfg), await res.json().catch(() => null));
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

const included = (cfg: AppConfig) => boatAccount(cfg)?.included === true;

/** `purpose` tells the Admin's relay this is the Cloud's browser sandbox, outside the plan's computers and hours; a
 * person's own key goes to the provider, which takes no such field. */
export const browserSandboxCreateBody = (viaRelay: boolean) =>
  ({ ttlSeconds: BROWSER_SANDBOX_TTL_SECONDS, noEnv: true, type: BROWSER_SANDBOX_TYPE, ...(viaRelay ? { purpose: "browser" } : {}) });

export function providerOps(cfg: () => AppConfig): ComputerOps {
  async function create(): Promise<{ id: string; state: string }> {
    const config = cfg();
    const body = JSON.stringify(browserSandboxCreateBody(included(config)));
    let request = beginBoatCreate(BROWSER_SANDBOX_OWNER, body).request;
    let answer = request.boxId ? await json(config, `/sandboxes/${request.boxId}`) : null;
    let posted = false;
    if (!answer?.ok) {
      posted = true;
      answer = await json(config, "/sandboxes", { method: "POST", headers: { "Idempotency-Key": request.idempotencyKey }, body, signal: AbortSignal.timeout(45_000) });
      // The relay already holds this Cloud's browser sandbox (a create whose answer was lost): that one is ours.
      const existing = answer.body?.boxId ?? answer.body?.error?.boxId;
      if (answer.status === 409 && (answer.body?.code ?? answer.body?.error?.code) === "browser_sandbox_exists" && typeof existing === "string") {
        answer = { ok: true, status: 200, body: { sandbox: { id: existing, state: "unknown" } } };
        posted = false;
      }
    }
    const boxId = answer.body?.sandbox?.id;
    if (!answer.ok || typeof boxId !== "string") {
      if (answer.status < 500 && answer.status !== 409) discardBoatCreate(request);
      throw boatRefusal(answer.status, "making the browser sandbox", answer.body, included(config));
    }
    request = rememberCreatedBoat(request, boxId);
    // A relay from before the browser sandbox made a plan computer instead, which would take the plan's slot: deleted at once.
    if (posted && included(config) && answer.body.sandbox.purpose !== "browser") {
      resolveBoatCreate(request);
      await requestRecordedBoatDeletion(config, { boxId, name: await boatNameFor(BROWSER_SANDBOX_OWNER), ownerBotId: BROWSER_SANDBOX_OWNER }).catch(() => "pending");
      throw new OldRelay();
    }
    const named = await json(config, `/sandboxes/${boxId}`, { method: "PATCH", body: JSON.stringify({ name: await boatNameFor(BROWSER_SANDBOX_OWNER) }) });
    if (!named.ok) throw boatRefusal(named.status, "naming the browser sandbox", named.body, included(config));
    resolveBoatCreate(request);
    return { id: boxId, state: typeof answer.body.sandbox.state === "string" ? answer.body.sandbox.state : "unknown" };
  }
  return {
    async find() {
      const found = await findBoat(cfg(), BROWSER_SANDBOX_OWNER);
      return found && typeof found.id === "string" ? { id: found.id, state: typeof found.state === "string" ? found.state : "unknown" } : null;
    },
    create,
    async resume(boxId) {
      const answer = await json(cfg(), `/sandboxes/${boxId}/resume`, { method: "POST" });
      // 409: a wake already under way; it is waited for like this one.
      if (!answer.ok && answer.status !== 409) throw boatRefusal(answer.status, "waking the browser sandbox", answer.body, included(cfg()));
    },
    async state(boxId) {
      const answer = await json(cfg(), `/sandboxes/${boxId}`);
      const state = answer.body?.sandbox?.state;
      return typeof state === "string" ? state : null;
    },
    run: (boxId, command, timeoutMs) => runCommand(cfg(), boxId, command, { timeoutMs }),
    async host(boxId, port) {
      const answer = await json(cfg(), `/sandboxes/${boxId}/host`, { method: "POST", body: JSON.stringify({ port, localhost: true }) });
      return answer.ok && typeof answer.body?.url === "string" ? answer.body.url : null;
    },
    async remove(boxId) {
      const name = await boatNameFor(BROWSER_SANDBOX_OWNER);
      return (await requestRecordedBoatDeletion(cfg(), { boxId, name, ownerBotId: BROWSER_SANDBOX_OWNER })) === "confirmed";
    },
  };
}

/** The Cloud's relay does not know the browser sandbox yet (an Admin from before it): no route today. */
export class OldRelay extends Error {}

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
  /** Called just before the start goes out, so it counts whatever the answer. */
  starting(): void;
  budgetMs?: number;
  pollMs?: number;
}

/** The sandbox ready to take commands: made or woken with at most one start, then read until it says so. */
export async function wakeSandbox(ops: ComputerOps, options: WakeOptions): Promise<{ id: string; started: boolean }> {
  let found = await ops.find();
  if (found && TERMINAL.has(found.state)) throw new Error("the browser sandbox is broken at the provider");
  if (found && READY.has(found.state)) return { id: found.id, started: false };
  // Archiving: its snapshot must land before it can be resumed, and another stop path owns it now.
  if (found?.state === "archiving") throw new StaysHome("busy");
  let started = false;
  if (!found || SLEEPING_BOAT_STATES.has(found.state)) {
    if (!options.mayStart()) throw new StaysHome("budget");
    options.starting();
    started = true;
    if (!found) found = await ops.create();
    else await ops.resume(found.id);
  }
  const id = found.id;
  const deadline = Date.now() + (options.budgetMs ?? 45_000);
  // Quick reads first: a resume after a short stop is ready in well under a second.
  for (let reads = 0; Date.now() < deadline; reads++) {
    await new Promise((resolve) => setTimeout(resolve, reads < 12 ? Math.min(250, options.pollMs ?? 250) : options.pollMs ?? 1_000));
    const state = await ops.state(id).catch(() => null);
    if (state && READY.has(state)) return { id, started };
    if (state && TERMINAL.has(state)) break;
    // Never a second start: a refused resume is billed as one too.
  }
  throw new Error("the browser sandbox did not become ready in time");
}

const DOOR_SOURCE = String.raw`
import net from "node:net"; import fs from "node:fs"; import { timingSafeEqual } from "node:crypto";
const D = process.argv[2], PORT = Number(process.argv[3]);
const read = (f) => { try { return fs.readFileSync(D + f, "utf8"); } catch { return ""; } };
const same = (a, b) => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
net.createServer((s) => {
  let buf = Buffer.alloc(0);
  const t = setTimeout(() => s.destroy(), 10000);
  s.on("error", () => s.destroy());
  const on = (c) => {
    buf = Buffer.concat([buf, c]);
    const e = buf.indexOf("\r\n\r\n");
    if (e < 0) { if (buf.length > 16384) s.destroy(); return; }
    s.off("data", on); clearTimeout(t);
    const head = buf.subarray(0, e).toString("latin1").split("\r\n"), rest = buf.subarray(e + 4);
    const [, key = "", secret = ""] = /^\/([a-f0-9]{16})\/([a-f0-9]+)$/.exec((head[0].split(" ")[1] || "").split("?")[0]) || [];
    const ports = key ? read("/" + key + "/profile/DevToolsActivePort").split("\n").map((x) => x.trim()) : [];
    if (!key || !same(secret, read("/" + key + "/secret").trim()) || !ports[1]) { s.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); return; }
    const keep = head.slice(1).filter((h) => !/^(host|origin|forwarded|x-forwarded-[a-z-]*|x-real-ip):/i.test(h));
    const up = net.connect(Number(ports[0]), "127.0.0.1", () => {
      up.write(["GET " + ports[1] + " HTTP/1.1", "Host: 127.0.0.1:" + ports[0], ...keep, "", ""].join("\r\n"));
      if (rest.length) up.write(rest);
      s.pipe(up); up.pipe(s);
    });
    up.on("error", () => s.destroy()); up.on("close", () => s.destroy()); s.on("close", () => up.destroy());
  };
  s.on("data", on);
}).listen(PORT, "127.0.0.1");
`;

/** The door's source, for its own test. */
export const doorSource = (): string => DOOR_SOURCE;

const check = (key: string, secret: string) => {
  if (!/^[a-f0-9]{16}$/.test(key)) throw new Error("bad profile key");
  if (!/^[a-f0-9]{32,128}$/.test(secret)) throw new Error("bad door secret");
};

/**
 * One command: write this open's secret for one bot's profile, start that profile's Chrome unless it already runs
 * (clearing a profile lock an earlier host left: nothing runs on it, so no live Chrome holds it), start the door unless it
 * runs, and put the door on the provider's relay. Prints one JSON line: whether Chrome answers, and the relay's URL when
 * the sandbox gave one. Chrome and the door start with an empty environment: no provider variable reaches a page. Each
 * bot's profile is its own folder (its own user-data-dir and Chrome), so no bot's pages see another's cookies.
 */
export function launchCommand(key: string, secret: string, port = COMPUTER_DOOR_PORT): string {
  check(key, secret);
  const D = COMPUTER_BROWSER_DIR;
  const clean = 'env -i HOME="$HOME" PATH="/usr/local/bin:/usr/bin:/bin" setsid nohup';
  return [
    `D="${D}"; K="$D/${key}"; P="$K/profile"; mkdir -p "$P"; chmod 700 "$D" "$K"`,
    `umask 077; printf %s '${secret}' > "$K/secret"`,
    `if ! pgrep -f -- "--user-data-dir=$P" >/dev/null 2>&1; then`,
    `  rm -f "$P/SingletonLock" "$P/SingletonSocket" "$P/SingletonCookie" "$P/DevToolsActivePort"`,
    `  B=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)`,
    `  V=$("$B" --version 2>/dev/null | grep -o '[0-9][0-9.]*' | head -1)`,
    `  ${clean} "$B" --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --user-data-dir="$P" --no-first-run --no-default-browser-check --password-store=basic --use-mock-keychain --disable-dev-shm-usage --window-size=1280,800 --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$V Safari/537.36" about:blank >"$K/chrome.log" 2>&1 </dev/null &`,
    "fi",
    `for i in $(seq 1 80); do [ -s "$P/DevToolsActivePort" ] && break; sleep 0.1; done`,
    `if ! pgrep -f -- "$D/door.mjs" >/dev/null 2>&1; then`,
    `  cat > "$D/door.mjs" <<'OMB_DOOR'${DOOR_SOURCE}OMB_DOOR`,
    `  ${clean} node "$D/door.mjs" "$D" ${port} >"$D/door.log" 2>&1 </dev/null &`,
    "fi",
    `(host ${port} --localhost >/dev/null 2>&1 || true)`,
    `U=$(host url ${port} --localhost 2>/dev/null | grep -o 'https://[^[:space:]]*' | head -1)`,
    `C=false; [ -s "$P/DevToolsActivePort" ] && C=true`,
    `printf '{"chrome":%s,"url":"%s"}\\n' "$C" "$U"`,
  ].join("\n");
}

/** One bot's Chrome asked to quit, so it writes its cookies; the others keep running. */
export function quitCommand(key: string): string {
  if (!/^[a-f0-9]{16}$/.test(key)) throw new Error("bad profile key");
  return [
    `P="${COMPUTER_BROWSER_DIR}/${key}/profile"`,
    `pkill -TERM -f -- "--user-data-dir=$P" 2>/dev/null || true`,
    `for i in $(seq 1 20); do pgrep -f -- "--user-data-dir=$P" >/dev/null 2>&1 || break; sleep 0.1; done`,
  ].join("\n");
}

/** Every Chrome and the door asked to quit, before the sandbox stops. */
export const QUIT_ALL_COMMAND = [
  `D="${COMPUTER_BROWSER_DIR}"`,
  `pkill -TERM -f -- "--user-data-dir=$D/" 2>/dev/null || true`,
  `pkill -TERM -f -- "$D/door.mjs" 2>/dev/null || true`,
  `for i in $(seq 1 30); do pgrep -f -- "--user-data-dir=$D/" >/dev/null 2>&1 || break; sleep 0.1; done`,
].join("\n");

/** The launch's answer: whether Chrome answers, and the relay URL the sandbox printed (a secret: never logged). */
export function launchAnswer(outcome: CommandOutcome): { chrome: boolean; url: string | null } {
  const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as { chrome?: unknown; url?: unknown };
    const url = typeof parsed.url === "string" && parsed.url ? parsed.url : null;
    return { chrome: parsed.chrome === true, url };
  } catch {
    return { chrome: false, url: null };
  }
}
