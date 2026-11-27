// What the GitHub sign-in card shows, shared by every card on screen (the Apps row, a chat's card): one status, one
// poll. The status is asked for while a card is shown, and asked again only while GitHub CLI is being prepared or a
// code waits for approval; nothing is pushed.
import { useSyncExternalStore } from "react";

import { GITHUB_SIGN_IN_PATH, type GithubSignInStatus } from "../../shared/github-sign-in";
import type { LocaleKey } from "@/locales";
import { api as storeApi } from "@/state/store";

export const GITHUB_DEVICE_URL = "https://github.com/login/device";
export const GITHUB_APPLICATIONS_URL = "https://github.com/settings/applications";
export const GITHUB_TOKENS_URL = "https://github.com/settings/personal-access-tokens";
export const GITHUB_NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
export const INSTALLING_POLL_MS = 1_500;
export const SIGNING_IN_POLL_MS = 3_000;
/** A code past its expiry by this much is not asked about again: the server has said it expired, or cannot say. */
export const EXPIRY_GRACE_MS = 60_000;
/** Reads that fail in a row before polling gives up and offers Retry; each failure doubles the wait. */
export const POLL_FAILURES_MAX = 5;

/** Only GitHub's own device page is ever drawn as a link: anything else the server says is not opened. */
export function isGithubDeviceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.hostname === "github.com" && url.port === "" && url.username === "" && url.password === ""
    && url.pathname === "/login/device" && url.search === "" && url.hash === "" && !/[?#]/.test(value);
}

/** "abcd1234" and "ABCD-1234" both read "ABCD-1234"; a code of another shape is shown as it came, upper-cased. */
export function groupCode(code: string): string {
  const plain = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : code.trim().toUpperCase();
}

/** The code one character at a time, for a screen reader: "A B C D, 1 2 3 4". */
export function spellCode(code: string): string {
  return groupCode(code).split("-").map((group) => [...group].join(" ")).join(", ");
}

export type GithubSignInBusy = "start" | "cancel" | "token" | "sign-out" | null;

export interface GithubSignInView {
  /** hidden: this person may not see or change this sign-in (a member's room, a client without the owner's rights). */
  phase: "loading" | "ready" | "hidden" | "error";
  status: GithubSignInStatus | null;
  busy: GithubSignInBusy;
  /** Start was refused (their own GitHub CLI, or Windows' saved sign-in): offer a pasted token. */
  refused: boolean;
  error: LocaleKey | null;
}

type Api = (path: string, init?: RequestInit & { background?: boolean }) => Promise<unknown>;
type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
type Read = Promise<void>;

const statusOf = (cause: unknown): number | undefined => {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

function isStatus(value: unknown): value is GithubSignInStatus {
  const state = (value as { state?: unknown } | null)?.state;
  return state === "signed-out" || state === "installing" || state === "signing-in" || state === "signed-in" || state === "invalid";
}

const INITIAL: GithubSignInView = { phase: "loading", status: null, busy: null, refused: false, error: null };

export function createGithubSignInStore(deps: { api?: Api; timers?: Timers; now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const api: Api = deps.api ?? storeApi;
  const timers: Timers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  let view = INITIAL;
  let reads = 0;
  let timer: unknown = null;
  let failures = 0;
  let reading: Read | null = null;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<GithubSignInView>) => {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
    schedule();
  };
  const stopPolling = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  function schedule() {
    const state = view.status?.state;
    const wait = state === "installing" ? INSTALLING_POLL_MS : state === "signing-in" ? SIGNING_IN_POLL_MS : null;
    if (wait === null || !listeners.size || view.phase !== "ready") return stopPolling();
    if (view.status?.state === "signing-in" && now() > view.status.expiresAt + EXPIRY_GRACE_MS) return stopPolling();
    if (timer !== null) return;
    timer = timers.set(() => {
      timer = null;
      void read({ background: true });
    }, wait * 2 ** failures);
  }

  /** A status answer; a 403 hides the card, anything else that fails keeps what was shown, or offers Retry. */
  function read(options: { check?: boolean; background?: boolean } = {}): Read {
    const started = ask(options);
    reading = started;
    void started.finally(() => { if (reading === started) reading = null; });
    return started;
  }

  async function ask(options: { check?: boolean; background?: boolean }): Read {
    const mine = ++reads;
    try {
      const answer = await api(`${GITHUB_SIGN_IN_PATH}${options.check ? "?check=1" : ""}`, options.background ? { background: true } : undefined);
      if (mine !== reads) return;
      if (!isStatus(answer)) throw new Error("unexpected GitHub sign-in status");
      failures = 0;
      set({ phase: "ready", status: answer, refused: answer.state === "signed-in" ? false : view.refused });
    } catch (cause) {
      if (mine !== reads) return;
      if (statusOf(cause) === 403) return set({ phase: "hidden", status: null });
      failures += 1;
      if (view.status && failures < POLL_FAILURES_MAX) set({});
      else set({ phase: "error" });
    }
  }

  async function act(busy: Exclude<GithubSignInBusy, null>, action: string, body?: string): Promise<boolean> {
    if (view.busy) return false;
    reads++;
    set({ busy, error: null });
    try {
      const answer = await api(`${GITHUB_SIGN_IN_PATH}/${action}`, { method: "POST", ...(body === undefined ? {} : { body }) });
      if (!isStatus(answer)) throw new Error("unexpected GitHub sign-in status");
      failures = 0;
      set({ phase: "ready", status: answer, busy: null, refused: action === "start" || answer.state === "signed-in" ? false : view.refused });
      return true;
    } catch (cause) {
      const status = statusOf(cause);
      set({ busy: null });
      if (status === 403) set({ phase: "hidden", status: null });
      else if (action === "start" && status === 409) {
        // The server's reasons differ (their own GitHub CLI is signed in, it could not be read, Windows holds a saved
        // sign-in): what it says now decides, and a token is offered unless that is already signed in.
        await read();
        if (view.status?.state !== "signed-in") set({ refused: true });
      } else if (action === "token") set({ error: status === 400 ? "githubSignIn.tokenRejected" : status === 502 ? "githubSignIn.tokenUnchecked" : "githubSignIn.failed" });
      else set({ error: "githubSignIn.failed" });
      return false;
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      // Each time a card comes into view after none was, the answer is asked for again: a sign-in can change elsewhere.
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) void read();
      schedule();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stopPolling();
      };
    },
    snapshot: (): GithubSignInView => view,
    /** Ask again now; `check` asks GitHub whether the saved sign-in still works. */
    refresh: (check = false) => { failures = 0; return read({ check }); },
    /** The answer being read now, else a new one: a card that just came into view asks once, not twice. */
    fresh: (): Read => reading ?? read(),
    start: () => act("start", "start"),
    cancel: () => act("cancel", "cancel"),
    signOut: () => act("sign-out", "sign-out"),
    /** The token goes in this one request's body and is kept nowhere here. */
    saveToken: (token: string) => act("token", "token", JSON.stringify({ token })),
    polling: () => timer !== null,
  };
}

export type GithubSignInStore = ReturnType<typeof createGithubSignInStore>;

export const githubSignIn = createGithubSignInStore({ api: (path, init) => storeApi(path, init) });

export function useGithubSignIn(store: GithubSignInStore = githubSignIn): GithubSignInView {
  return useSyncExternalStore(store.subscribe, store.snapshot, () => INITIAL);
}

/** Only what the Apps panel needs, so it is rendered again only when that changes. */
export function useGithubConnected(store: GithubSignInStore = githubSignIn): boolean | null {
  return useSyncExternalStore(store.subscribe, () => githubConnected(store.snapshot()), () => null);
}

/** False once the server said this sign-in isn't this person's to see. */
export function useGithubShown(store: GithubSignInStore = githubSignIn): boolean {
  return useSyncExternalStore(store.subscribe, () => store.snapshot().phase !== "hidden", () => true);
}

/** True while this person's GitHub is signed in, false when it is not or not theirs to see, null until known. */
export function githubConnected(view: GithubSignInView): boolean | null {
  if (view.phase === "loading") return null;
  return view.phase === "ready" && view.status?.state === "signed-in";
}

/** Where the person manages this sign-in on GitHub: the authorized apps for a code sign-in, the tokens page for a token. */
export function githubManageUrl(source: "mausbot" | "token" | "cli"): string {
  return source === "token" ? GITHUB_TOKENS_URL : GITHUB_APPLICATIONS_URL;
}
