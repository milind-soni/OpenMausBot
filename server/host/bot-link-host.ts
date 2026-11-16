// index.ts's wiring of the link between a person's computer and their Cloud (server/bot-link/link.ts): the link over this
// server's store and coordinator, the computer's end that asks the Cloud, and the routes. With the link off (no
// bot-link.json in the data folder) `start` asks nobody and every hook here answers as if the link did not exist.
import { createDialer } from "../bot-link/dial.ts";
import { createBotLink } from "../bot-link/link.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { redactSecretsInText } from "../redact.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotLinkRoutes, linkSessionUser } from "../routes/bot-link.ts";
import type { Level } from "../runtime/types.ts";
import type { BotRecord, Store } from "../store.ts";
import { sentRow, teammateResultRow } from "./handoff-sent.ts";

export interface BotLinkHostDeps {
  dataDir: string;
  environmentId: string;
  store: Pick<Store, "bots" | "bot" | "createTask" | "taskByThread" | "appendMessage" | "patchTask" | "onChange">;
  coordinator(): Coordinator;
  kick(): void;
  level(bot: BotRecord): Level;
  refusal(bot: BotRecord): string | null;
  language(threadId: string): string | undefined;
  personName(threadId: string): string | undefined;
  sessions: { issue(input: { label: string; scopes: Array<"admin" | "client">; email?: string; userId?: string }): { token: string; session: { id: string } }; revoke(id: string): boolean };
  local(auth: RequestAuth): boolean;
  owner(auth: RequestAuth): boolean;
  power(): { sleeping(): boolean; sleepSignal(): AbortSignal } | null | undefined;
  log(line: string): void;
}

export function createBotLinkHost(deps: BotLinkHostDeps) {
  const { store } = deps;
  const link = createBotLink({
    dataDir: deps.dataDir, coordinator: deps.coordinator, kick: deps.kick, log: deps.log, revoke: (sessionId) => { deps.sessions.revoke(sessionId); },
    bots: () => store.bots, bot: (id) => store.bot(id),
    refusal: (bot) => deps.refusal(bot as BotRecord),
    model: (bot) => (bot as BotRecord).modelSelection.model,
    level: (bot) => deps.level(bot as BotRecord),
    openThread: (bot, title, opener) => store.createTask(bot.id, title, false, undefined, { ...opener, at: Date.now(), kind: "work" })?.threadId,
    hasThread: (botId, threadId) => Boolean(store.taskByThread(botId, threadId)),
    personName: deps.personName,
    sentRow: ({ sender, threadId, recipient, workThreadId, reason, doneWhen }) => {
      store.appendMessage(threadId, sentRow({ sender: { id: sender.id, name: sender.name, color: sender.color ?? "blue" }, recipient: { ...recipient, color: "blue" }, threadId: workThreadId, via: "direct", language: deps.language(threadId),
        ...(reason ? { reason } : {}), ...(doneWhen ? { doneWhen: redactSecretsInText(doneWhen) } : {}) }));
    },
    resultRow: (parent: HandoffView, child: HandoffView, name: string) => {
      if (!store.taskByThread(parent.botId, parent.threadId)) return;
      const done = child.status === "completed";
      store.appendMessage(parent.threadId, { role: "bot", kind: "activity", roomRequest: { id: child.id, phase: "result" },
        tool: { name: teammateResultRow(deps.language(parent.threadId), child, name, undefined, undefined), ok: done,
          ...(done && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) } });
      if (!parent.parentId && parent.reply !== "poll") store.patchTask(parent.botId, parent.threadId, { unread: true });
    },
  });
  const dialer = createDialer({ link, log: deps.log });
  let stopWatching: (() => void) | undefined;
  const watch = () => { stopWatching ??= store.onChange((change) => { if (change.type.startsWith("bot.")) link.botsChanged(); }); };
  const routes = createBotLinkRoutes({ link, dialer, turnedOn: watch, environmentId: deps.environmentId, local: deps.local, owner: deps.owner, power: deps.power,
    // A personal Cloud issues no session without its owner's scopes, so the link's carries them; `linkSessionRefusal`
    // (wired where requests are admitted) keeps it to the link's own routes.
    issue: (auth, label, computerId) => {
      const issued = deps.sessions.issue({ label, scopes: [...auth.scopes], userId: linkSessionUser(computerId), ...(auth.kind === "session" && auth.session.email ? { email: auth.session.email } : {}) });
      return { token: issued.token, sessionId: issued.session.id };
    },
    revoke: (sessionId) => { deps.sessions.revoke(sessionId); } });
  let daily: NodeJS.Timeout | undefined;
  return {
    link, routes,
    /** Once the server is up. Off: nothing. On, on the computer: it starts asking the Cloud. */
    start(): void {
      if (!link.on()) return;
      watch();
      link.tidy();
      daily = setInterval(() => link.tidy(), 24 * 60 * 60_000);
      daily.unref?.();
      if (link.role() === "dialer") dialer.start({ gentle: true });
    },
    close(): void { if (daily) clearInterval(daily); stopWatching?.(); dialer.close(); link.close(); },
  };
}
