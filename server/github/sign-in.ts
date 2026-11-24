// GitHub sign-in for the server's own git and GitHub actions: GitHub CLI's device-code login (the person types a code on
// github.com; nothing is registered by the person or by OpenMausBot), or a pasted fine-grained token, or on This computer
// the person's own GitHub CLI sign-in, which is only ever read.
//
// One sign-in per audience: `owner` off a Team Cloud (the server's one), a member's person key on one, each in its own
// folder <data>/github/<audience>/ (config/: gh's config with the token, home/: gh's HOME). The data folder is never in a
// bot's box, and this folder is kept out of backups (workspace-backup-policy.ts). A token is never logged, never in a
// route's answer and never in a bot's environment: server code asks githubToken() for it.
//
// Nothing here runs at start-up and nothing runs on a timer. A login lives in memory only: after a restart it is gone
// (a gh that outlived the old server can still finish it, and then the folder simply shows signed in). Whether a saved
// sign-in still works is asked of GitHub when someone asks (status with check, or its first status in this run) or after
// a git action reported it refused (reportGithubAuthFailure), never otherwise.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { GithubSignInLast, GithubSignInSource, GithubSignInStatus } from "../../shared/github-sign-in.ts";
import type { VaultStore } from "../vault-store.ts";
import { GH_SIGN_IN_FLOOR, loginArgs, ownGhEnv, personalGhEnv, type GhChild, type GhTools } from "./gh-cli.ts";
import { hostsFileLogin, hostsFileToken, loginFailure, parseDeviceCode, parseScopes, parseStatusJson, parseStatusText, plain, tokenFrom, versionAtLeast, type GhAccount } from "./gh-output.ts";
import { personalGhLogin } from "./personal-hosts.ts";

/** GitHub's device codes last 15 minutes (its `expires_in`, 900 s); gh does not print it. */
export const DEVICE_CODE_TTL_MS = 15 * 60_000;
/** A gh that has printed no code this long after it started is not going to. */
const NO_CODE_MS = 2 * 60_000;
const OUTPUT_MAX = 64 * 1024;
const AUDIENCE = /^(?:owner|p_[\w-]{22})$/u;
const OWNER = "owner";

export class GithubSignInError extends Error {
  readonly status: 400 | 403 | 409 | 502;
  constructor(status: 400 | 403 | 409 | 502, message: string) {
    super(message);
    this.status = status;
    this.name = "GithubSignInError";
  }
}

interface Attempt {
  child: GhChild | null;
  phase: "installing" | "signing-in";
  startedAt: number;
  code?: string;
  verificationUrl?: string;
  expiresAt?: number;
  output: string;
  cancelled: boolean;
  /** Which gh ran it, so its later status and token calls use the same one. */
  gh?: string;
}

type Known = Extract<GithubSignInStatus, { state: "signed-in" | "invalid" }>;

interface Audience {
  attempt: Attempt | null;
  last?: GithubSignInLast;
  /** The last answer GitHub gave about the saved sign-in, until it changes or someone asks again. */
  known?: Known;
  /** The person's own GitHub CLI was read in this run and had no sign-in: not read again until asked to check. */
  personalNone?: boolean;
  stale: boolean;
}

export interface GithubSignInDeps {
  dataDir: string;
  /** A Team Cloud: every audience is a member's person key, and none is the server's. */
  team: boolean;
  tools: GhTools;
  vault: Pick<VaultStore, "githubToken" | "setGithubToken">;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests only: the platform whose credential-store rules apply. */
  platform?: NodeJS.Platform;
  /** A token just read, so held-secret redaction masks it wherever text reaches a bot or a transcript. */
  remember?(token: string): void;
}

export interface GithubSignIn {
  status(audience: string, options?: { check?: boolean }): Promise<GithubSignInStatus>;
  start(audience: string): Promise<GithubSignInStatus>;
  cancel(audience: string): Promise<GithubSignInStatus>;
  saveToken(audience: string, token: string): Promise<GithubSignInStatus>;
  signOut(audience: string): Promise<GithubSignInStatus>;
  /** The token for server-side git and GitHub calls, or null. Never logged, never a route's answer, never a bot's env. */
  token(audience?: string | null): Promise<string | null>;
  /** A git or GitHub call with this audience's token was refused: the next status asks GitHub again. */
  reportAuthFailure(audience?: string | null): void;
  /** Whether `audience` has a sign-in to ask token() for, answered from disk without running gh or asking GitHub: for a
   * spawn that must decide at once whether to set git up (server/github/git-access.ts). It may say yes for a sign-in
   * GitHub no longer accepts; token() is still the answer. */
  signedIn(audience?: string | null): boolean;
  /** A member who left a Team Cloud: their sign-in folder and pasted token go. */
  forgetPerson(person: string): void;
}

export function githubFolders(dataDir: string, audience: string): { root: string; config: string; home: string } {
  if (!AUDIENCE.test(audience)) throw new GithubSignInError(403, "Sign in to this server to connect GitHub.");
  const root = join(dataDir, "github", audience);
  return { root, config: join(root, "config"), home: join(root, "home") };
}

export function createGithubSignIn(deps: GithubSignInDeps): GithubSignIn {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const audiences = new Map<string, Audience>();
  const of = (audience: string): Audience => {
    let found = audiences.get(audience);
    if (!found) {
      found = { attempt: null, stale: false };
      audiences.set(audience, found);
    }
    return found;
  };
  /** Off a Team Cloud the one audience is the server's; on one, only a member's own key, and never a fallback. */
  const resolve = (audience: string | null | undefined): string | null => {
    if (deps.team) return audience && audience !== OWNER && AUDIENCE.test(audience) ? audience : null;
    return audience === undefined || audience === null || audience === OWNER ? OWNER : null;
  };
  const must = (audience: string): string => {
    const key = resolve(audience);
    if (!key) throw new GithubSignInError(403, "Sign in to this server to connect GitHub.");
    return key;
  };
  const hostsFile = (audience: string) => join(githubFolders(deps.dataDir, audience).config, "hosts.yml");
  const ownLogin = (audience: string): string | null | undefined => {
    try {
      return hostsFileLogin(readFileSync(hostsFile(audience), "utf8"));
    } catch {
      return undefined;
    }
  };
  const ownSignedIn = (audience: string) => ownLogin(audience) !== undefined;
  /** The person's own gh may run OpenMausBot's sign-in only off a Team Cloud and when it takes every flag. */
  const personalForLogin = async (): Promise<string | null> => {
    const own = deps.team ? null : deps.tools.personal();
    return own && versionAtLeast(await deps.tools.version(own), GH_SIGN_IN_FLOOR) ? own : null;
  };
  /** A gh for OpenMausBot's own sign-in folder: the one that signed it in this run, the person's own, or the pinned copy. */
  /** A gh for OpenMausBot's own sign-in folder, never a download: only Start installs. The pinned copy is checked again
   * (installStandaloneEngine's reuse path) only when its folder names the pinned version, so a newer pin waits for Start. */
  const ownGh = async (audience: string): Promise<string | null> => of(audience).attempt?.gh ?? (await personalForLogin()) ?? deps.tools.pinnedReady()
    ?? (deps.tools.pinnedOnDisk() ? await deps.tools.install().catch(() => null) : null);
  const ownEnv = (audience: string) => {
    const folders = githubFolders(deps.dataDir, audience);
    for (const folder of [folders.config, folders.home, join(folders.home, ".run")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
    return ownGhEnv(folders);
  };

  async function ghAccount(file: string, env: Record<string, string>): Promise<GhAccount | "signed-out" | null> {
    const json = await deps.tools.run(file, ["auth", "status", "--hostname", "github.com", "--json", "hosts"], env);
    const fromJson = json.code === 0 ? parseStatusJson(json.stdout) : null;
    if (fromJson) return fromJson;
    const text = await deps.tools.run(file, ["auth", "status", "--hostname", "github.com"], env);
    return parseStatusText(`${text.stdout}\n${text.stderr}`);
  }

  async function orgsOf(file: string, env: Record<string, string>): Promise<string[] | undefined> {
    const result = await deps.tools.run(file, ["api", "user/orgs", "--paginate", "--jq", ".[].login"], env);
    if (result.code !== 0) return undefined;
    return plain(result.stdout).split("\n").map((line) => line.trim()).filter((line) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(line)).slice(0, 200);
  }

  function known(source: GithubSignInSource, account: GhAccount, fallbackLogin: string | null, orgs?: string[]): Known {
    const login = account.login ?? fallbackLogin;
    if (account.state === "invalid" || (!login && account.state === "success")) {
      return { state: "invalid", login, source, reason: source === "cli" ? "GitHub no longer accepts your GitHub CLI's sign-in. Sign in again there with `gh auth login`." : "GitHub no longer accepts this sign-in. Sign in again." };
    }
    // Unknown (no network, a timeout, an answer gh could not give): the sign-in is there and stays, just not checked.
    return { state: "signed-in", login: login ?? "unknown", source, scopes: account.scopes, ...(orgs ? { orgs } : {}), checkedAt: account.state === "success" ? now() : null };
  }

  /** What GitHub says of OpenMausBot's own gh sign-in. */
  async function checkOwn(audience: string, withOrgs: boolean): Promise<Known> {
    const login = ownLogin(audience) ?? null;
    try {
      const file = await ownGh(audience);
      if (!file) return { state: "signed-in", login: login ?? "unknown", source: "mausbot", scopes: [], checkedAt: null };
      const env = ownEnv(audience);
      const account = await ghAccount(file, env);
      // The config file is there, so an answer gh could not give is not a refusal: shown as signed in, unchecked.
      if (account === "signed-out" || account === null) return { state: "signed-in", login: login ?? "unknown", source: "mausbot", scopes: [], checkedAt: null };
      const orgs = withOrgs && account.state === "success" ? await orgsOf(file, env) : of(audience).known?.state === "signed-in" ? (of(audience).known as { orgs?: string[] }).orgs : undefined;
      return known("mausbot", account, login, orgs);
    } catch {
      // gh could not be put in place or run: the sign-in is there, its check is not.
      return { state: "signed-in", login: login ?? "unknown", source: "mausbot", scopes: [], checkedAt: null };
    }
  }

  async function checkToken(token: string, savedLogin: string | null): Promise<Known | "unreachable"> {
    let response: Response;
    try {
      response = await fetchImpl("https://api.github.com/user", {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "OpenMausBot", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return "unreachable";
    }
    // Only 401 is GitHub refusing the token; a 403 is also how it answers a rate limit, so it proves nothing.
    if (response.status === 401) return { state: "invalid", login: savedLogin, source: "token", reason: "GitHub no longer accepts this token. Paste a new one." };
    if (!response.ok) return "unreachable";
    const body = await response.json().catch(() => null) as { login?: unknown } | null;
    const login = typeof body?.login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(body.login) ? body.login : savedLogin;
    if (!login) return "unreachable";
    return { state: "signed-in", login, source: "token", scopes: parseScopes(response.headers.get("x-oauth-scopes")), checkedAt: now() };
  }

  /** The person's own GitHub CLI sign-in on This computer, read and never changed: null when they have no gh (or may not
   * use it here), "signed-out" when it says so, "unreadable" when its answer could not be read. */
  async function personalAccount(): Promise<Known | "signed-out" | "unreadable" | null> {
    const own = deps.team ? null : deps.tools.personal();
    if (!own) return null;
    const account = await ghAccount(own, personalGhEnv()).catch(() => null);
    if (account === "signed-out") return "signed-out";
    if (account === null) return "unreadable";
    return known("cli", account, null);
  }

  /** Ends an attempt whose time is up: a code past its expiry, or a gh that never printed one. No timer: asked on read. */
  function settleLate(audience: string): void {
    const state = of(audience), attempt = state.attempt;
    if (!attempt || !attempt.child) return;
    const late = attempt.phase === "signing-in" ? attempt.expiresAt !== undefined && now() > attempt.expiresAt : now() - attempt.startedAt > NO_CODE_MS;
    if (!late) return;
    attempt.child.kill("SIGTERM");
    state.attempt = null;
    state.last = attempt.phase === "signing-in" ? { outcome: "expired", reason: "The code expired before it was entered on GitHub.", at: now() } : { outcome: "failed", reason: "GitHub did not send a code in time. Try again.", at: now() };
  }

  function current(audience: string): GithubSignInStatus | null {
    settleLate(audience);
    const state = of(audience), attempt = state.attempt;
    if (!attempt) return null;
    if (attempt.phase === "signing-in" && attempt.code && attempt.verificationUrl && attempt.expiresAt) {
      return { state: "signing-in", code: attempt.code, verificationUrl: attempt.verificationUrl, expiresAt: attempt.expiresAt };
    }
    return { state: "installing" };
  }

  const withLast = (audience: string, status: GithubSignInStatus): GithubSignInStatus => {
    const last = of(audience).last;
    return last && status.state !== "signed-in" ? { ...status, last } : status;
  };

  /** Status calls of one audience that overlap share one answer, so parallel asks never each start gh. */
  const asking = new Map<string, Promise<GithubSignInStatus>>();
  function status(audienceIn: string, options: { check?: boolean } = {}): Promise<GithubSignInStatus> {
    let audience: string;
    try {
      audience = must(audienceIn);
    } catch (error) {
      return Promise.reject(error);
    }
    const running = asking.get(audience);
    if (running) return running;
    const answer = readStatus(audience, options).finally(() => asking.delete(audience));
    asking.set(audience, answer);
    return answer;
  }

  async function readStatus(audience: string, options: { check?: boolean }): Promise<GithubSignInStatus> {
    const live = current(audience);
    if (live) return withLast(audience, live);
    const state = of(audience);
    const ask = options.check === true || state.stale || !state.known;
    if (ownSignedIn(audience)) {
      if (ask || state.known?.source !== "mausbot") {
        state.known = await checkOwn(audience, state.known?.source !== "mausbot" || options.check === true);
        state.stale = false;
      }
      return state.known;
    }
    const saved = deps.vault.githubToken(audience);
    if (saved) {
      if (ask || state.known?.source !== "token") {
        const checked = await checkToken(saved.token, saved.login);
        state.known = checked === "unreachable" ? { state: "signed-in", login: saved.login, source: "token", scopes: [], checkedAt: null } : checked;
        state.stale = false;
      }
      return state.known;
    }
    if (!deps.team && deps.tools.personal()) {
      if (options.check === true || state.stale || (state.known?.source !== "cli" && !state.personalNone)) {
        const account = await personalAccount();
        state.known = typeof account === "object" && account !== null ? account : undefined;
        state.personalNone = state.known === undefined;
        state.stale = false;
      }
      if (state.known?.source === "cli") return state.known;
    }
    state.known = undefined;
    const download = !(await personalForLogin()) && !deps.tools.pinnedReady() && !deps.tools.pinnedOnDisk();
    return withLast(audience, { state: "signed-out", download });
  }

  function finish(audience: string, attempt: Attempt, code: number | null): void {
    const state = of(audience);
    if (state.attempt !== attempt) return;
    state.attempt = null;
    if (attempt.cancelled) {
      state.last = { outcome: "cancelled", at: now() };
      return;
    }
    if (code === 0 && ownSignedIn(audience)) {
      state.last = undefined;
      state.stale = true;
      // One source at a time: a pasted token steps aside for the sign-in just made.
      if (deps.vault.githubToken(audience)) deps.vault.setGithubToken(audience, null);
      return;
    }
    const failure = loginFailure(attempt.output);
    state.last = { outcome: failure.outcome, reason: failure.reason, at: now() };
  }

  function launch(audience: string, attempt: Attempt, file: string, version: [number, number, number] | null): void {
    attempt.gh = file;
    attempt.phase = "installing";
    let child: GhChild;
    try {
      child = deps.tools.spawn(file, loginArgs(version), ownEnv(audience));
    } catch {
      finish(audience, attempt, 1);
      return;
    }
    attempt.child = child;
    const receive = (chunk: Buffer | string) => {
      if (attempt.output.length < OUTPUT_MAX) attempt.output += String(chunk).slice(0, OUTPUT_MAX - attempt.output.length);
      if (attempt.code) return;
      const shown = parseDeviceCode(attempt.output);
      if (!shown) return;
      Object.assign(attempt, { phase: "signing-in", code: shown.code, verificationUrl: shown.verificationUrl, expiresAt: now() + DEVICE_CODE_TTL_MS });
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", (error) => {
      attempt.output += `\n${error.message}`;
      finish(audience, attempt, 1);
    });
    child.once("close", (code) => finish(audience, attempt, code));
  }

  async function start(audienceIn: string): Promise<GithubSignInStatus> {
    const audience = must(audienceIn);
    const live = current(audience);
    if (live) return live;
    if (ownSignedIn(audience)) throw new GithubSignInError(409, "GitHub is already signed in here. Sign out first to use another account.");
    // Held from here, so a second Start while this one looks around joins it rather than starting another gh.
    const state = of(audience);
    const attempt: Attempt = { child: null, phase: "installing", startedAt: now(), output: "", cancelled: false };
    state.attempt = attempt;
    state.last = undefined;
    const stillOurs = () => state.attempt === attempt && !attempt.cancelled;
    try {
      // Security: the person's own gh keeps its sign-in in the OS credential store, which a gh login touches whatever its
      // folder (gh-cli.ts). While their own sign-in works, OpenMausBot never starts one of its own.
      // Only a positive answer lets it go ahead: no gh of theirs, theirs signed out, or GitHub refusing theirs (401).
      const theirs = deps.team ? null : await personalAccount();
      if (theirs === "unreadable") throw new GithubSignInError(409, "Your own GitHub CLI's sign-in could not be checked, so nothing was changed. Try again.");
      if (theirs !== null && theirs !== "signed-out" && theirs.state === "signed-in") {
        state.known = theirs;
        throw new GithubSignInError(409, `GitHub is already signed in on this computer as ${theirs.login}, with your own GitHub CLI.`);
      }
      // Windows' Credential Manager is one store whatever gh's folder (gh-cli.ts), so there only a positive "none" will do:
      // their gh saying signed out, or no gh entry there at all. A refused sign-in of theirs (401) is not enough either:
      // its entry, under the same login, would be what our new sign-in resolves to.
      if ((deps.platform ?? process.platform) === "win32" && !deps.team && theirs !== "signed-out") {
        const entries = theirs === null ? await deps.tools.windowsGhCredentials() : null;
        if (theirs !== null || entries === null || entries.length > 0) {
          throw new GithubSignInError(409, "This computer's Windows Credential Manager already holds a GitHub CLI sign-in, which signing in here could change. Paste a GitHub token instead, or sign in again with your own GitHub CLI.");
        }
      }
      const file = (await personalForLogin()) ?? deps.tools.pinnedReady();
      if (file) {
        const version = await deps.tools.version(file);
        if (stillOurs()) launch(audience, attempt, file, version);
      } else {
        // The first sign-in here fetches the pinned GitHub CLI; the card shows "installing" and asks again.
        void deps.tools.install().then(async (installed) => {
          const version = await deps.tools.version(installed);
          if (!stillOurs()) return;
          // The clock for a code starts when gh does.
          attempt.startedAt = now();
          launch(audience, attempt, installed, version);
        }, (error: unknown) => {
          if (state.attempt !== attempt) return;
          state.attempt = null;
          state.last = { outcome: "failed", reason: error instanceof Error ? error.message.slice(0, 300) : "GitHub CLI could not be installed.", at: now() };
        });
      }
    } catch (error) {
      if (state.attempt === attempt) state.attempt = null;
      throw error;
    }
    return withLast(audience, current(audience) ?? (await readStatus(audience, {})));
  }

  function stopAttempt(audience: string): void {
    const state = of(audience), attempt = state.attempt;
    if (!attempt) return;
    attempt.cancelled = true;
    state.attempt = null;
    state.last = { outcome: "cancelled", at: now() };
    attempt.child?.kill("SIGTERM");
  }

  async function cancel(audienceIn: string): Promise<GithubSignInStatus> {
    const audience = must(audienceIn);
    stopAttempt(audience);
    return readStatus(audience, {});
  }

  async function saveToken(audienceIn: string, raw: string): Promise<GithubSignInStatus> {
    const audience = must(audienceIn);
    const token = typeof raw === "string" ? raw.trim() : "";
    if (!/^[A-Za-z0-9_]{20,255}$/u.test(token)) throw new GithubSignInError(400, "Paste a GitHub token: it starts with github_pat_ (fine-grained) or ghp_.");
    const checked = await checkToken(token, null);
    if (checked === "unreachable") throw new GithubSignInError(502, "GitHub could not check the token just now. Try again in a minute.");
    if (checked.state !== "signed-in") throw new GithubSignInError(400, "GitHub did not accept this token. Check it and paste it again.");
    stopAttempt(audience);
    // One source at a time: the pasted token replaces OpenMausBot's own gh sign-in.
    rmSync(githubFolders(deps.dataDir, audience).root, { recursive: true, force: true });
    deps.vault.setGithubToken(audience, { token, login: checked.login });
    const state = of(audience);
    Object.assign(state, { known: checked, stale: false, last: undefined });
    return checked;
  }

  async function signOut(audienceIn: string): Promise<GithubSignInStatus> {
    const audience = must(audienceIn);
    stopAttempt(audience);
    const ours = ownSignedIn(audience) || existsSync(githubFolders(deps.dataDir, audience).root) || deps.vault.githubToken(audience) !== null;
    if (!ours) {
      const shown = await readStatus(audience, {});
      if (shown.state !== "signed-out" && "source" in shown && shown.source === "cli") {
        throw new GithubSignInError(409, "This sign-in is your own GitHub CLI's. Sign out there with `gh auth logout`.");
      }
      return shown;
    }
    // Never `gh auth logout`: it also deletes the OS credential store's entries for github.com, which on This computer are
    // the person's own (gh-cli.ts). The token was only ever in this folder, so removing the folder forgets it; neither
    // revokes it on GitHub (docs: GitHub sign-in).
    rmSync(githubFolders(deps.dataDir, audience).root, { recursive: true, force: true });
    if (deps.vault.githubToken(audience)) deps.vault.setGithubToken(audience, null);
    Object.assign(of(audience), { known: undefined, stale: false, last: undefined });
    return readStatus(audience, {});
  }

  async function token(audienceIn?: string | null): Promise<string | null> {
    const audience = resolve(audienceIn);
    if (!audience) return null;
    const remember = (value: string | null) => {
      if (value) deps.remember?.(value);
      return value;
    };
    try {
      if (ownSignedIn(audience)) {
        // gh renews an expiring sign-in itself when asked for its token.
        const file = await ownGh(audience);
        // No gh to ask (a newer pin not yet installed): the token gh saved in its own file, as gh itself would read it.
        if (!file) return remember(hostsFileToken(readFileSync(hostsFile(audience), "utf8")));
        const result = await deps.tools.run(file, ["auth", "token", "--hostname", "github.com"], ownEnv(audience));
        return remember(result.code === 0 ? tokenFrom(result.stdout) : null);
      }
      const saved = deps.vault.githubToken(audience);
      if (saved) return remember(saved.token);
      const own = deps.team ? null : deps.tools.personal();
      if (!own) return null;
      const result = await deps.tools.run(own, ["auth", "token", "--hostname", "github.com"], personalGhEnv());
      return remember(result.code === 0 ? tokenFrom(result.stdout) : null);
    } catch {
      return null;
    }
  }

  return {
    status, start, cancel, saveToken, signOut, token,
    reportAuthFailure(audienceIn) {
      const audience = resolve(audienceIn);
      if (audience) of(audience).stale = true;
    },
    signedIn(audienceIn) {
      const audience = resolve(audienceIn);
      if (!audience) return false;
      try {
        return ownSignedIn(audience) || deps.vault.githubToken(audience) !== null || (!deps.team && deps.tools.personal() !== null && personalGhLogin() !== null);
      } catch {
        return false;
      }
    },
    forgetPerson(person) {
      if (!AUDIENCE.test(person) || person === OWNER) return;
      const state = audiences.get(person);
      if (state?.attempt) {
        state.attempt.cancelled = true;
        state.attempt.child?.kill("SIGTERM");
      }
      audiences.delete(person);
      rmSync(githubFolders(deps.dataDir, person).root, { recursive: true, force: true });
    },
  };
}
