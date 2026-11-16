// index.ts's wiring of the link between a person's computer and their Cloud (server/bot-link/link.ts): the link over this
// server's store and coordinator, the computer's end that asks the Cloud, and the routes. With the link off (no
// bot-link.json in the data folder) `start` asks nobody and every hook here answers as if the link did not exist.
import { dirname } from "node:path";

import { createDialer } from "../bot-link/dial.ts";
import { createBotLink } from "../bot-link/link.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { redactSecretsInText } from "../redact.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotLinkRoutes, linkSessionUser } from "../routes/bot-link.ts";
import type { Level } from "../runtime/types.ts";
import type { BotRecord, Store } from "../store.ts";
import type { HandoffFiles, PassedFile } from "./handoff-files.ts";
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
  files: Pick<HandoffFiles, "carried" | "crossed" | "sentWith" | "returnedWith">;
  /** One crossed file into the attachment store, named by its bytes, under attach_file's own type and size rules. */
  storeFile(path: string, name: string, root: string): Promise<{ attachment: { kind: string; path: string; mime: string; name?: string }; bytes: number }>;
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
    files: {
      carried: deps.files.carried, crossed: deps.files.crossed,
      store: async (files) => {
        const stored: PassedFile[] = [];
        for (const file of files) {
          const { attachment, bytes } = await deps.storeFile(file.path, file.name, dirname(file.path));
          if (attachment.kind === "image" || attachment.kind === "file") stored.push({ kind: attachment.kind, path: attachment.path, name: attachment.name || file.name, mime: attachment.mime, bytes });
        }
        return stored;
      },
    },
    sentRow: ({ sender, threadId, recipient, workThreadId, nodeId, reason, doneWhen }) => {
      store.appendMessage(threadId, sentRow({ sender: { id: sender.id, name: sender.name, color: sender.color ?? "blue" }, recipient: { ...recipient, color: "blue" }, threadId: workThreadId, via: "direct", language: deps.language(threadId),
        ...(reason ? { reason } : {}), ...(doneWhen ? { doneWhen: redactSecretsInText(doneWhen) } : {}), ...deps.files.sentWith(nodeId) }));
    },
    resultRow: (parent: HandoffView, child: HandoffView, name: string) => {
      if (!store.taskByThread(parent.botId, parent.threadId)) return;
      const done = child.status === "completed";
      store.appendMessage(parent.threadId, { role: "bot", kind: "activity", roomRequest: { id: child.id, phase: "result" }, ...deps.files.returnedWith(child, parent),
        tool: { name: teammateResultRow(deps.language(parent.threadId), child, name, undefined, undefined), ok: done,
          ...(done && child.result.trim() ? { output: redactSecretsInText(child.result.trim()).slice(0, 2_000) } : {}) } });
      if (!parent.parentId && parent.reply !== "poll") store.patchTask(parent.botId, parent.threadId, { unread: true });
    },
  });
  const dialer = createDialer({ link, log: deps.log });
  let stopWatching: (() => void) | undefined, upkeep: NodeJS.Timeout | undefined;
  /** While the link is on: bot changes reach the other places, and old records and stray file bytes are cleared hourly. */
  const watch = () => {
    stopWatching ??= store.onChange((change) => { if (change.type.startsWith("bot.")) link.botsChanged(); });
    if (upkeep) return;
    upkeep = setInterval(() => link.tidy(), 60 * 60_000);
    upkeep.unref?.();
  };
  const routes = createBotLinkRoutes({ link, dialer, turnedOn: watch, environmentId: deps.environmentId, local: deps.local, owner: deps.owner, power: deps.power,
    // A personal Cloud issues no session without its owner's scopes, so the link's carries them; `linkSessionRefusal`
    // (wired where requests are admitted) keeps it to the link's own routes.
    issue: (auth, label, computerId) => {
      const issued = deps.sessions.issue({ label, scopes: [...auth.scopes], userId: linkSessionUser(computerId), ...(auth.kind === "session" && auth.session.email ? { email: auth.session.email } : {}) });
      return { token: issued.token, sessionId: issued.session.id };
    },
    revoke: (sessionId) => { deps.sessions.revoke(sessionId); } });
  return {
    link, routes,
    /** Once the server is up. Off: nothing. On, on the computer: it starts asking the Cloud. */
    start(): void {
      if (!link.on()) return;
      watch();
      link.tidy();
      if (link.role() === "dialer") dialer.start({ gentle: true });
    },
    close(): void { if (upkeep) clearInterval(upkeep); stopWatching?.(); dialer.close(); link.close(); },
  };
}
