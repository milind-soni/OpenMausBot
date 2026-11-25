// A pass sends nothing again and rewrites no notice until the AI's status, read afresh, says it is signed in, and it
// acts only on what was left before the sign-in it answers. Only refusals the driver proves never reached the model are
// kept, so sending one again repeats no work.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SIGNED_IN_AGAIN, signInNotice } from "../../shared/sign-in-notice.ts";
import { sameModelSelection } from "../../shared/thread-model.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { chatNotice } from "../chat-notices.ts";
import { isFreshStart } from "../fresh-start.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { Message, Store } from "../store.ts";
import { nothingRan } from "../turn-outcome.ts";
import type { UsageTrigger } from "../usage-ledger.ts";

export const RESUME_WINDOW_MS = 24 * 60 * 60_000;
const NOTICE_TTL_MS = 30 * 24 * 60 * 60_000;
export const RECHECK_MS = 15_000;
const RECHECK_MAX_MS = 5 * 60_000;
/** Status reads that did not say signed in, in a row, before an AI's waiting messages wait for its next sign-in. */
export const RECHECKS_UNANSWERED = 5;

export interface SignInWait {
  botId: string;
  threadId: string;
  messageId: string;
  selection: ModelSelection;
  trigger?: UsageTrigger;
  failedAt: number;
}

export interface SignedOutNotice { instanceId: string; threadId: string; messageId: string; at: number }

interface Saved { waiting?: SignInWait[]; notices?: SignedOutNotice[] }

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const savedWait = (row: unknown): row is SignInWait => {
  const wait = row as Partial<SignInWait> | null;
  return Boolean(wait) && text(wait!.botId) && text(wait!.threadId) && text(wait!.messageId) && Number.isFinite(wait!.failedAt)
    && text(wait!.selection?.instanceId) && typeof wait!.selection?.model === "string";
};
const savedNotice = (row: unknown): row is SignedOutNotice => {
  const notice = row as Partial<SignedOutNotice> | null;
  return Boolean(notice) && text(notice!.instanceId) && text(notice!.threadId) && text(notice!.messageId) && Number.isFinite(notice!.at);
};

export interface SignInResumeDeps {
  file?: string;
  store: Pick<Store, "activePath" | "messagesFor" | "taskByThread" | "projectBotForTask" | "patchMessage">;
  /** The AI's status, read afresh: null unless it says it is signed in, else whether the instance read still stands. */
  signedInNow(instanceId: string): Promise<(() => boolean) | null>;
  engineName(instanceId: string): string;
  /** The conversation is working or has messages queued. */
  busy(botId: string, threadId: string): boolean;
  atCapacity(botId: string, threadId: string): boolean;
  /** Sends `message` again as its conversation's Retry does. */
  retry(wait: SignInWait, message: Message): Promise<unknown>;
  now?: () => number;
  after?: (ms: number, run: () => void) => void;
  log?: (line: string) => void;
}

/** What waits on a person's own message that `selection`'s sign-out stopped at `failedAt`, before the model saw it. */
export function signInWait(store: Pick<Store, "projectBotForTask">, botId: string, threadId: string, messageId: string | undefined, trigger: UsageTrigger | undefined, failedAt: number): SignInWait | null {
  const selection = store.projectBotForTask(botId, threadId)?.modelSelection;
  return messageId && selection ? { botId, threadId, messageId, selection, failedAt, ...(trigger ? { trigger } : {}) } : null;
}

export function createSignInResume(deps: SignInResumeDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const after = deps.after ?? ((ms: number, run: () => void) => { setTimeout(run, ms).unref?.(); });
  let waiting: SignInWait[] = [];
  let notices: SignedOutNotice[] = [];
  const sending = new Set<SignInWait>();
  const signedInAt = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();
  const queuedPasses = new Map<string, Promise<void>>();
  const rechecks = new Map<string, { ms: number; armed: boolean; unanswered: number }>();

  const prune = (): void => {
    const at = now();
    waiting = waiting.filter((wait) => at - wait.failedAt < RESUME_WINDOW_MS);
    notices = notices.filter((notice) => at - notice.at < NOTICE_TTL_MS);
  };

  if (deps.file) {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(deps.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`sign-in resume: could not read the saved file: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (saved !== undefined && (!saved || typeof saved !== "object" || Array.isArray(saved))) log("sign-in resume: the saved file is not an object; left out");
    else if (saved) {
      const rows = (key: keyof Saved) => {
        const value = (saved as Record<string, unknown>)[key];
        return Array.isArray(value) ? value : [];
      };
      waiting = rows("waiting").filter(savedWait);
      notices = rows("notices").filter(savedNotice);
      const dropped = rows("waiting").length + rows("notices").length - waiting.length - notices.length;
      if (dropped) log(`sign-in resume: left out ${dropped} unreadable saved rows`);
    }
    prune();
  }

  const save = (): void => {
    if (!deps.file) return;
    try {
      writeFileAtomic(deps.file, JSON.stringify({ waiting, notices } satisfies Saved), { mode: 0o600 });
    } catch (error) {
      log(`sign-in resume: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const resumable = (wait: SignInWait): Message | "park" | null => {
    const { store } = deps;
    if (!store.taskByThread(wait.botId, wait.threadId) || deps.busy(wait.botId, wait.threadId)) return null;
    const all = store.messagesFor(wait.threadId);
    if (all.some((row) => row.id !== wait.messageId && (row.role === "user" || isFreshStart(row)) && row.at >= wait.failedAt)) return null;
    const path = store.activePath(wait.threadId);
    const at = path.findIndex((message) => message.id === wait.messageId);
    const message = path[at];
    if (!message || message.role !== "user" || message.kind !== "text" || !message.text || message.peerAsk || message.relayed || message.via || message.fromApp || message.reaction) return null;
    const answered = message.replyToId ? all.find((row) => row.id === message.replyToId) : undefined;
    if (answered?.widget || answered?.app) return null;
    const since = path.slice(at + 1);
    if (since.some((row) => row.role === "user" || isFreshStart(row)) || !nothingRan(since, 0, undefined)) return null;
    if (!sameModelSelection(store.projectBotForTask(wait.botId, wait.threadId)?.modelSelection, wait.selection)) return null;
    return deps.atCapacity(wait.botId, wait.threadId) ? "park" : message;
  };

  const signedInAgainTool = (instanceId: string): NonNullable<Message["tool"]> => {
    const engine = deps.engineName(instanceId);
    return { name: `notice: ${chatNotice(SIGNED_IN_AGAIN, { engine })}`, nameCode: SIGNED_IN_AGAIN, nameParams: { engine }, ok: true };
  };

  const recheckState = (instanceId: string) => {
    const state = rechecks.get(instanceId) ?? { ms: RECHECK_MS, armed: false, unanswered: 0 };
    rechecks.set(instanceId, state);
    return state;
  };
  const resetRecheck = (instanceId: string): void => {
    const state = recheckState(instanceId);
    state.ms = RECHECK_MS;
    state.unanswered = 0;
  };

  const recheck = (instanceId: string, unanswered: boolean): void => {
    const state = recheckState(instanceId);
    state.unanswered = unanswered ? state.unanswered + 1 : 0;
    if (state.armed || state.unanswered >= RECHECKS_UNANSWERED) return;
    state.armed = true;
    after(state.ms, () => {
      state.armed = false;
      void pass(instanceId);
    });
    state.ms = Math.min(state.ms * 2, RECHECK_MAX_MS);
  };

  const run = async (instanceId: string): Promise<void> => {
    const signedInWhen = signedInAt.get(instanceId) ?? now();
    const mine = (row: { selection?: ModelSelection; instanceId?: string; failedAt?: number; at?: number }) =>
      (row.selection?.instanceId ?? row.instanceId) === instanceId && (row.failedAt ?? row.at ?? 0) < signedInWhen;
    if (!waiting.some(mine) && !notices.some(mine)) return;
    const stands = await deps.signedInNow(instanceId).catch(() => null);
    if (!stands) {
      if (waiting.some(mine) || notices.some(mine)) recheck(instanceId, true);
      return;
    }
    prune();
    let parked = false;
    for (const wait of waiting.filter((one) => mine(one) && !sending.has(one))) {
      if (!stands()) break;
      const message = now() - wait.failedAt < RESUME_WINDOW_MS ? resumable(wait) : null;
      if (message === "park") {
        parked = true;
        continue;
      }
      if (message) {
        sending.add(wait);
        try {
          await deps.retry(wait, message);
        } catch (error) {
          log(`sign-in resume: could not send ${wait.threadId}'s message again: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          sending.delete(wait);
        }
      }
      waiting = waiting.filter((other) => other !== wait);
      save();
    }
    if (!stands()) {
      save();
      recheck(instanceId, true);
      return;
    }
    for (const notice of notices.filter(mine)) {
      const row = deps.store.messagesFor(notice.threadId).find((message) => message.id === notice.messageId);
      if (row?.tool?.setup && signInNotice(row)) deps.store.patchMessage(notice.threadId, notice.messageId, { tool: signedInAgainTool(instanceId) });
      notices = notices.filter((other) => other !== notice);
    }
    save();
    if (parked) recheck(instanceId, false);
    else resetRecheck(instanceId);
  };

  const pass = (instanceId: string): Promise<void> => {
    const waitingToStart = queuedPasses.get(instanceId);
    if (waitingToStart) return waitingToStart;
    const next = (chains.get(instanceId) ?? Promise.resolve()).then(() => {
      queuedPasses.delete(instanceId);
      return run(instanceId);
    }).catch((error: unknown) => log(`sign-in resume: ${error instanceof Error ? error.message : String(error)}`));
    queuedPasses.set(instanceId, next);
    chains.set(instanceId, next);
    return next;
  };

  const signedInSince = (instanceId: string, at: number) => (signedInAt.get(instanceId) ?? -Infinity) > at;

  return {
    /** A person's own message its AI's sign-out stopped before the model saw it, once that turn has settled and no other AI
     * carried it on. */
    waiting(wait: SignInWait): Promise<void> | undefined {
      if (waiting.some((other) => other.botId === wait.botId && other.threadId === wait.threadId && other.failedAt > wait.failedAt)) return undefined;
      waiting = waiting.filter((other) => sending.has(other) || other.botId !== wait.botId || other.threadId !== wait.threadId).concat(wait);
      save();
      return signedInSince(wait.selection.instanceId, wait.failedAt) ? pass(wait.selection.instanceId) : undefined;
    },
    /** A signed-out notice row a conversation shows. */
    noticed(notice: SignedOutNotice): Promise<void> | undefined {
      notices.push(notice);
      save();
      return signedInSince(notice.instanceId, notice.at) ? pass(notice.instanceId) : undefined;
    },
    /** Something says this AI is signed in again: a status read, or a sign-in in the app. */
    signedIn(instanceId: string): Promise<void> {
      signedInAt.set(instanceId, now());
      resetRecheck(instanceId);
      return pass(instanceId);
    },
    /** After a restart: each AI with a conversation still waiting or a notice still showing is asked once. */
    resumeSaved(): Promise<void> {
      const at = now();
      const engines = new Set([...waiting.map((wait) => wait.selection.instanceId), ...notices.map((notice) => notice.instanceId)]);
      for (const instanceId of engines) if (!signedInAt.has(instanceId)) signedInAt.set(instanceId, at);
      return Promise.all([...engines].map(pass)).then(() => undefined);
    },
  };
}

export type SignInResume = ReturnType<typeof createSignInResume>;

/** Both sign-in events, a status read that turns signed in and a sign-in in the app, clear the takeover's hold before a
 * pass, so the turn it sends again is not held at its start. */
export function createSignInResumeHost(deps: Omit<SignInResumeDeps, "file" | "signedInNow" | "retry"> & {
  dataDir: string;
  registry: Pick<ProviderRegistry, "forgetSnapshots" | "get" | "onSignedIn" | "sawSignedIn">;
  takeover: { signedIn(instanceId: string): void };
  startTurn(botId: string, text: string, opts: { threadId: string; editedMessageId: string; replyTo?: Message; dataContext?: Message["dataContext"]; trigger?: UsageTrigger; sender?: Message["sender"] }): Promise<unknown>;
  replyTarget(threadId: string, id: string): Message | undefined;
  startupRead: Promise<unknown> | null;
}) {
  const { registry } = deps;
  const resume = createSignInResume({
    ...deps,
    file: join(deps.dataDir, "sign-in-resume.json"),
    signedInNow: async (instanceId) => {
      registry.forgetSnapshots();
      const instance = registry.get(instanceId);
      const snapshot = await instance?.snapshot();
      const stands = () => Boolean(instance) && registry.get(instanceId) === instance;
      return stands() && snapshot?.state === "available" && snapshot.authenticated === true ? stands : null;
    },
    retry: (wait, message) => deps.startTurn(wait.botId, message.text ?? "", {
      threadId: wait.threadId, editedMessageId: message.id, dataContext: message.dataContext,
      ...(message.replyToId ? { replyTo: deps.replyTarget(wait.threadId, message.replyToId) } : {}),
      ...(wait.trigger ? { trigger: wait.trigger } : {}), ...(message.sender ? { sender: message.sender } : {}),
    }),
  });
  const signedIn = (instanceId: string): void => {
    deps.takeover.signedIn(instanceId);
    void resume.signedIn(instanceId);
  };
  registry.onSignedIn(signedIn);
  void Promise.resolve(deps.startupRead).then(() => resume.resumeSaved());
  /** A sign-in made in the app is a sign-in, and the status read that later finds it does not tell it again. */
  const appSignedIn = (instanceId: string): void => {
    registry.sawSignedIn(instanceId);
    signedIn(instanceId);
  };
  return { ...resume, signedIn, appSignedIn };
}
