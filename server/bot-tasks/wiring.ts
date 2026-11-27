// Bot tasks as the server runs them: the ledger, its poll loop, the app's routes, the bots' tools and a frame for every
// change. GitHub is reached only through the credential Settings names (the gh CLI's token or the saved one).
import type { BotTasksSettings } from "../../shared/bot-tasks.ts";
import type { AppConfig } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotTaskToolRoutes } from "../routes/bot-task-tools.ts";
import { createBotTasksRoutes } from "../routes/bot-tasks.ts";
import { createGithubClient, resolveGithubToken } from "./github.ts";
import { createBotTasks, type GithubPort } from "./service.ts";
import { botTasksSettings } from "./settings.ts";
import { syncGithubTask } from "./sync.ts";

export interface BotTasksHostDeps {
  dataDir: string;
  config(): AppConfig;
  vaultToken(): string | null;
  botName(botId: string): string | undefined;
  bots(): ReadonlyArray<{ id: string; name: string }>;
  person(auth: RequestAuth): string;
  broadcast(payload: Record<string, unknown>): void;
  /** Tests shorten it. */
  tickMs?: number;
  now?: () => number;
}

const TICK_MS = 30_000;

export function createBotTasksHost(deps: BotTasksHostDeps) {
  const now = deps.now ?? Date.now;
  const settings = (): BotTasksSettings => botTasksSettings(deps.config());
  const token = () => {
    const { credential } = settings();
    return resolveGithubToken(credential, credential === "vault" ? deps.vaultToken() : null);
  };
  const client = createGithubClient({ token, now });
  const port: GithubPort = {
    lookupEvidence: client.lookupEvidence,
    pullCommitEvidence: client.pullCommitEvidence,
    async sync(task, since) {
      const result = await syncGithubTask({ task, client, now: now(), since });
      const activity = result.activity.filter((entry): entry is Exclude<typeof entry, { type: "github_ref" }> => entry.type !== "github_ref");
      return { ref: result.ref, githubState: { state: result.githubState.state }, activity };
    },
    pull: async (ref) => { const item = await client.pull(ref.repo, ref.number); return { kind: item.kind, state: item.state, mergeable: item.mergeable, headSha: item.headSha, htmlUrl: item.htmlUrl }; },
    postComment: (ref, text, taskId) => client.postComment({ ...ref, taskId }, text),
    merge: (ref, sha) => client.merge(ref, { sha }),
  };
  const tasks = createBotTasks({ dataDir: deps.dataDir, now, settings, botName: deps.botName, github: () => port });
  tasks.onChange((taskId) => deps.broadcast({ kind: "bot-task", taskId }));

  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  let lastRun = now();
  const active = () => settings().enabled && settings().githubSync;
  async function tick() {
    if (ticking || !active() || now() - lastRun < settings().pollMinutes * 60_000) return;
    ticking = true;
    try {
      await tasks.syncAll();
    } catch (error) {
      console.error(`bot-tasks: poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      lastRun = now();
      ticking = false;
    }
  }

  return {
    tasks,
    routes: createBotTasksRoutes({ tasks, enabled: () => settings().enabled, person: deps.person }),
    toolRoutes: (turn: { requireActive(): void; botId(): string; readBody(): Promise<unknown> }) =>
      createBotTaskToolRoutes({ ...turn, tasks, settings, botName: deps.botName, bots: deps.bots }),
    start(): void {
      if (timer) return;
      lastRun = now();
      timer = setInterval(() => void tick(), deps.tickMs ?? TICK_MS);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get isTicking(): boolean { return ticking; },
    nextDueAt: (): number | null => (timer && active() ? lastRun + settings().pollMinutes * 60_000 : null),
    /** The poll loop's one step; tests call it instead of waiting. */
    tick,
  };
}

export type BotTasksHost = ReturnType<typeof createBotTasksHost>;
