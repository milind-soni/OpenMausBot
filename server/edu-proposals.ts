// Edu canonical proposals (https://github.com/EduardoMoraga/edu): a bot may only propose a canonical note; a person
// approves or rejects it here. Edu 6.0.0 lists them with `edu brain proposals --json` and decides them with
// `edu brain approve`, which refuses a crew worker (EDU_CREW_JOB) and, without a terminal, anyone who omits `--yes`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EduBrainView, EduDecideRights, EduProposal } from "../shared/edu-brain.ts";
import { eduProposalSummary, eduProposalTitle, type EduSay } from "../shared/edu-proposal-words.ts";
import type { NeedsYouItem } from "../shared/today.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { DecisionRow } from "./decision-log.ts";
import type { EduBot, EduBrains, EduRuntime } from "./edu-brain.ts";
import { AGENTS_NODE_FLAG } from "./proxy-paths.ts";
import type { RequestAuth } from "./request-auth.ts";
import { isInside, resolveThroughLinks } from "./sentinel/paths.ts";
import { conversationLanguage, serverLine } from "./server-lines.ts";

export const EDU_PROPOSAL_TOOL = "edu_propose_canonical";
export const EDU_REJECT_REASON = "Rejected in Edu Bot";
const LIST_TIMEOUT_MS = 15_000;
const DECIDE_TIMEOUT_MS = 30_000;
const REFRESH_MS = 60_000;
const BODY_CHARS = 600;
const PROPOSAL_ID = /^[A-Za-z0-9][\w.-]{0,199}$/;

export type EduRun = (args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

interface Speaker { id: string; name: string; color: string; eduBrain?: EduBot["eduBrain"] }
type CardMessage = { id: string; card?: OptionCardData; from?: { botId: string } };

export interface EduProposalDeps {
  brains: Pick<EduBrains, "detect" | "brain" | "brainFolder">;
  store: {
    bot(id: string): Speaker | null | undefined;
    readonly bots: ReadonlyArray<Speaker & { threadId: string; hidden?: boolean }>;
    readonly groups: ReadonlyArray<{ threadId: string; memberIds: readonly string[]; tasks?: ReadonlyArray<{ threadId: string }> }>;
    tasks(botId: string): ReadonlyArray<{ threadId: string }>;
    messagesFor(threadId: string): CardMessage[];
    appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: OptionCardData; from?: { botId: string; name: string; color: string } }): { id: string };
    patchMessage(threadId: string, messageId: string, patch: { card: OptionCardData }): unknown;
  };
  /** A room thread, where a card names its bot. */
  inRoom(threadId: string): boolean;
  decide(row: Omit<DecisionRow, "at">): void;
  /** The packaged desktop app, whose loopback mutations carry its own token. */
  desktop: boolean;
  bus?: { subscribe(listener: (event: { type: string; threadId: string }) => void): () => void };
  env?: NodeJS.ProcessEnv;
  /** Runs `edu` with Node: args start with the CLI script. */
  run?: EduRun;
  now?(): number;
}

export type EduDecision =
  | { ok: true; outcome: "allowed-once" | "rejected" | "unavailable"; alreadySettled?: true }
  | { ok: false; status: number; error: string };

function nodeRun(args: string[], { env, timeoutMs }: { env: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr || (error && code === -1 ? error.message : "")) });
    });
  });
}

/** The exact `edu` arguments, after the CLI script, for listing and deciding one proposal in `folder`'s brain. */
export const eduCommands = {
  list: (folder: string) => ["--cwd", folder, "brain", "proposals", "--json"],
  approve: (folder: string, id: string) => ["--cwd", folder, "brain", "approve", id, "--yes", "--json"],
  reject: (folder: string, id: string) => ["--cwd", folder, "brain", "approve", "--reject", id, "--reason", EDU_REJECT_REASON, "--yes", "--json"],
};

/** A proposal's note text without its frontmatter, shortened. */
export function proposalBody(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    if (!text) return undefined;
    return text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS).trimEnd()}…` : text;
  } catch {
    return undefined;
  }
}

/** Edu's listing as proposals of this brain or the global one; anything else, or an id that could pass for a flag, is
 * dropped. `shared`: the bot names this brain's folder itself. */
export function parseProposals(stdout: string, folder: string, globalHome: string, shared = false): EduProposal[] {
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("edu brain proposals did not print a list");
  const own = join(folder, ".edu");
  const home = resolveThroughLinks(globalHome);
  const proposals: EduProposal[] = [];
  for (const row of rows) {
    const raw = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const text = (key: string) => typeof raw[key] === "string" ? raw[key] as string : "";
    const id = text("id"), path = text("path");
    if (!PROPOSAL_ID.test(id) || !path) continue;
    const real = resolveThroughLinks(path);
    const global = !isInside(real, own) && isInside(real, home);
    if (!global && !isInside(real, own)) continue;
    const body = proposalBody(real);
    proposals.push({ id, title: text("title") || id, kind: text("kind"), band: text("band") || "unbanded", why: text("why"), brain: folder, global,
      location: global ? globalHome : folder, ...(shared ? { shared: true } : {}), ...(body ? { body } : {}) });
  }
  return proposals;
}

/** What Edu did with `id`: `gone` when it is no longer a proposal (decided elsewhere or never there). */
export function decisionOf(stdout: string, id: string): "accepted" | "rejected" | "gone" | { error: string } {
  let result: { accepted?: unknown; rejected?: unknown; errors?: unknown };
  try { result = JSON.parse(stdout) as typeof result; } catch { return { error: "Edu printed no result" }; }
  if (Array.isArray(result.accepted) && result.accepted.includes(id)) return "accepted";
  if (Array.isArray(result.rejected) && result.rejected.includes(id)) return "rejected";
  const error = Array.isArray(result.errors) ? result.errors.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === id) as { error?: unknown } | undefined : undefined;
  const words = typeof error?.error === "string" ? error.error : "";
  if (/not found|only proposed/i.test(words)) return "gone";
  return { error: words || "Edu did not decide this proposal" };
}

export const eduProposalKey = (proposal: Pick<EduProposal, "brain" | "id">) => `${proposal.brain}\0${proposal.id}`;

const openCard = (card: OptionCardData | undefined): card is OptionCardData & { eduProposal: EduProposal } =>
  Boolean(card?.eduProposal && card.requestId && !card.answered && !card.dismissed && !card.expired);

/** A card's words in the conversation's language, for clients that do not word it from `eduProposal`. */
export function proposalCardWords(proposal: EduProposal, botName: string, language?: string): { title: string; subtitle: string; options: string[] } {
  const say: EduSay = (key, params) => serverLine(language, key, params);
  return {
    title: eduProposalTitle(proposal, botName, say),
    subtitle: eduProposalSummary(proposal, botName, say),
    options: [serverLine(language, "server.edu.approve"), serverLine(language, "server.edu.reject")],
  };
}

export function createEduProposals(deps: EduProposalDeps) {
  const env = deps.env ?? process.env;
  const run = deps.run ?? nodeRun;
  const now = deps.now ?? Date.now;
  const mounted = new Map<string, { botId: string; folder: string }>();
  const sweeping = new Map<string, Promise<void>>();
  const cache = new Map<string, { at: number; botId: string; proposals: EduProposal[] }>();
  const firstSeen = new Map<string, number>();
  const posted = new Map<string, { threadId: string; messageId: string }>();
  let refreshing: Promise<void> | null = null;
  let refreshedAt = 0;

  const crewWorker = () => Boolean(env.EDU_CREW_JOB?.trim());

  function eduEnv(runtime: EduRuntime): NodeJS.ProcessEnv {
    const clean: NodeJS.ProcessEnv = { ...env, ...AGENTS_NODE_FLAG, EDU_HOME: runtime.home };
    delete clean.EDU_CREW_JOB;
    return clean;
  }

  async function list(folder: string, runtime: EduRuntime, bot: Pick<Speaker, "eduBrain">): Promise<EduProposal[]> {
    const result = await run([runtime.cli!, ...eduCommands.list(folder)], { env: eduEnv(runtime), timeoutMs: LIST_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").at(-1) || `edu exited with ${result.code}`);
    return parseProposals(result.stdout, folder, runtime.home, bot.eduBrain?.mode === "folder");
  }

  function remember(botId: string, folder: string, proposals: EduProposal[]) {
    cache.set(folder, { at: now(), botId, proposals });
    for (const proposal of proposals) if (!firstSeen.has(eduProposalKey(proposal))) firstSeen.set(eduProposalKey(proposal), now());
  }

  /** The conversations that may hold a card for this brain: those of the bots on it, and the rooms they are in. */
  function cardThreads(folder: string, extra?: string): string[] {
    const threads = new Set<string>(extra ? [extra] : []);
    const real = resolveThroughLinks(folder);
    const onBrain = new Set<string>();
    for (const bot of deps.store.bots) {
      const own = deps.brains.brainFolder(bot);
      if (!own || resolveThroughLinks(own) !== real) continue;
      onBrain.add(bot.id);
      threads.add(bot.threadId);
      for (const task of deps.store.tasks(bot.id)) threads.add(task.threadId);
    }
    for (const group of deps.store.groups) {
      if (!group.memberIds.some((id) => onBrain.has(id))) continue;
      threads.add(group.threadId);
      for (const task of group.tasks ?? []) threads.add(task.threadId);
    }
    for (const [key, at] of posted) if (key.startsWith(`${folder}\0`)) threads.add(at.threadId);
    return [...threads];
  }

  function openCards(folder: string, extra?: string): Map<string, Array<{ threadId: string; message: CardMessage & { card: OptionCardData & { eduProposal: EduProposal } } }>> {
    const found = new Map<string, Array<{ threadId: string; message: CardMessage & { card: OptionCardData & { eduProposal: EduProposal } } }>>();
    for (const threadId of cardThreads(folder, extra)) {
      for (const message of deps.store.messagesFor(threadId)) {
        if (!openCard(message.card) || message.card.eduProposal.brain !== folder) continue;
        const key = eduProposalKey(message.card.eduProposal);
        found.set(key, [...(found.get(key) ?? []), { threadId, message: message as CardMessage & { card: OptionCardData & { eduProposal: EduProposal } } }]);
      }
    }
    return found;
  }

  function settle(threadId: string, message: CardMessage & { card: OptionCardData }, answered: "allow" | "deny" | "unavailable") {
    deps.store.patchMessage(threadId, message.id, { card: { ...message.card, answered, ...(answered === "unavailable" ? { dismissed: true } : {}) } });
  }

  function post(threadId: string, bot: Speaker, proposal: EduProposal) {
    const requestId = `edu-${randomUUID()}`;
    const words = proposalCardWords(proposal, bot.name, conversationLanguage(threadId));
    const message = deps.store.appendMessage(threadId, {
      role: "bot",
      kind: "options",
      ...(deps.inRoom(threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
      card: { ...words, fixedOptions: true, requestId, tool: EDU_PROPOSAL_TOOL, eduProposal: proposal },
    });
    posted.set(eduProposalKey(proposal), { threadId, messageId: message.id });
    deps.decide({ threadId, requestId, botId: bot.id, botName: bot.name, tool: EDU_PROPOSAL_TOOL, summary: words.subtitle, decision: "card-shown", source: "edu-brain" });
  }

  /** After a turn that had the brain mounted: a card for each new proposal in the bot's own brain, and open cards of
   * proposals decided elsewhere become unavailable. Global proposals wait in Memory settings and Needs you instead. One
   * sweep of a brain at a time, so two bots on it never card the same proposal twice. */
  function sweep(threadId: string, botId: string, folder: string): Promise<void> {
    const before = sweeping.get(folder) ?? Promise.resolve();
    const next = before.then(() => sweepNow(threadId, botId, folder));
    const tail = next.catch(() => {});
    sweeping.set(folder, tail);
    void tail.then(() => { if (sweeping.get(folder) === tail) sweeping.delete(folder); });
    return next;
  }

  async function sweepNow(threadId: string, botId: string, folder: string): Promise<void> {
    const bot = deps.store.bot(botId);
    const runtime = await deps.brains.detect();
    if (!bot || runtime.state !== "ready") return;
    const proposals = await list(folder, runtime, bot);
    remember(botId, folder, proposals);
    const pending = new Set(proposals.map(eduProposalKey));
    const open = openCards(folder, threadId);
    for (const [key, cards] of open) if (!pending.has(key)) for (const card of cards) settle(card.threadId, card.message, "unavailable");
    for (const proposal of proposals) if (!proposal.global && !open.has(eduProposalKey(proposal))) post(threadId, bot, proposal);
  }

  async function decide(folder: string, id: string, approve: boolean, global: boolean): Promise<"accepted" | "rejected" | "gone" | { status: number; error: string }> {
    if (!PROPOSAL_ID.test(id)) return { status: 400, error: "That isn't an Edu proposal id." };
    if (crewWorker()) return { status: 409, error: "Edu Bot is running inside an Edu crew job, so Edu won't let it decide proposals. Decide them in Edu itself." };
    const runtime = await deps.brains.detect();
    if (runtime.state !== "ready" || !runtime.cli) return { status: 503, error: "Edu isn't available right now. Check the Edu brain in this bot's Memory settings." };
    const args = approve ? eduCommands.approve(folder, id) : eduCommands.reject(folder, id);
    const result = await run([runtime.cli, ...args], { env: eduEnv(runtime), timeoutMs: DECIDE_TIMEOUT_MS });
    const decision = decisionOf(result.stdout, id);
    if (typeof decision === "object") return { status: 502, error: `Edu couldn't decide this proposal: ${result.stderr.trim().split("\n").at(-1) || decision.error}` };
    for (const [key, cached] of cache) {
      if (key !== folder && !global) continue;
      cache.set(key, { ...cached, proposals: cached.proposals.filter((proposal) => proposal.id !== id || (key !== folder && !proposal.global)) });
    }
    return decision;
  }

  function settleAll(folder: string, id: string, outcome: "accepted" | "rejected" | "gone", from: { botId?: string; botName?: string; threadId: string; requestId?: string; summary?: string }) {
    const cards = openCards(folder).get(eduProposalKey({ brain: folder, id })) ?? [];
    for (const card of cards) settle(card.threadId, card.message, outcome === "accepted" ? "allow" : outcome === "rejected" ? "deny" : "unavailable");
    if (outcome === "gone") return;
    deps.decide({ ...from, requestId: from.requestId ?? cards[0]?.message.card.requestId, tool: EDU_PROPOSAL_TOOL,
      decision: outcome === "accepted" ? "user-approved" : "user-denied", source: "user" });
  }

  const outcomeOf = (decision: "accepted" | "rejected" | "gone") =>
    decision === "accepted" ? "allowed-once" as const : decision === "rejected" ? "rejected" as const : "unavailable" as const;

  async function refresh(): Promise<void> {
    const runtime = await deps.brains.detect();
    if (runtime.state !== "ready") return;
    const seen = new Set<string>();
    for (const bot of deps.store.bots) {
      const folder = bot.hidden ? null : deps.brains.brainFolder(bot);
      if (!folder || seen.has(folder) || !existsSync(join(folder, ".edu"))) continue;
      seen.add(folder);
      const brain = await deps.brains.brain(bot);
      if (!brain.ok) continue;
      try { remember(bot.id, brain.folder, await list(brain.folder, runtime, bot)); } catch {}
    }
  }

  deps.bus?.subscribe((event) => {
    if (event.type !== "turn.completed" && event.type !== "session.exited") return;
    const turn = mounted.get(event.threadId);
    if (!turn) return;
    mounted.delete(event.threadId);
    sweep(event.threadId, turn.botId, turn.folder).catch((error: unknown) =>
      console.warn(`edu: proposals not checked after a turn of bot ${turn.botId}: ${error instanceof Error ? error.message : String(error)}`));
  });

  return {
    sweep,

    /** The turn starting in `threadId` has this bot's brain mounted (`null`: none); its proposals are checked when the turn
     * ends, however it ends. */
    mounted(threadId: string, bot: { id: string }, folder: string | null): void {
      if (folder) mounted.set(threadId, { botId: bot.id, folder });
      else mounted.delete(threadId);
    },

    /** Security: Edu lets only a person decide a proposal. A loopback service (a bot or script on a shared server) may
     * only reject, a loopback caller outside the desktop app may only reject (a bot's shell is one), and a session needs
     * the admin scope. `undefined` when the card is not an Edu proposal. */
    answerRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null | undefined {
      const card = deps.store.messagesFor(threadId).find((message) => message.card?.requestId === requestId)?.card;
      if (!card?.eduProposal) return undefined;
      return eduDecisionRefusal(auth, deps.desktop, behavior !== "deny");
    },

    /** `GET /api/edu/rights`, and what Memory settings offers: the same rule as deciding. */
    rights(auth: RequestAuth): EduDecideRights {
      const crew = crewWorker();
      return {
        mayApprove: !crew && eduDecisionRefusal(auth, deps.desktop, true) === null,
        mayReject: !crew && eduDecisionRefusal(auth, deps.desktop, false) === null,
        ...(crew ? { crewWorker: true } : {}),
      };
    },

    /** The person's answer on a card; null when the request is not an Edu proposal card. */
    async resolve(threadId: string, requestId: string, behavior: string): Promise<EduDecision | null> {
      const message = deps.store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId && candidate.card.eduProposal);
      const proposal = message?.card?.eduProposal;
      if (!message?.card || !proposal) return null;
      if (behavior !== "allow" && behavior !== "deny") return { ok: false, status: 400, error: "Approve or reject an Edu proposal; it takes no other answer." };
      if (message.card.answered) return { ok: true, outcome: message.card.answered === "allow" ? "allowed-once" : message.card.answered === "deny" ? "rejected" : "unavailable", alreadySettled: true };
      const decision = await decide(proposal.brain, proposal.id, behavior === "allow", proposal.global);
      if (typeof decision === "object") return { ok: false, ...decision };
      const bot = message.from?.botId ? deps.store.bot(message.from.botId) : deps.store.bots.find((candidate) => candidate.threadId === threadId || deps.store.tasks(candidate.id).some((task) => task.threadId === threadId));
      settleAll(proposal.brain, proposal.id, decision, { threadId, requestId, botId: bot?.id, botName: bot?.name, summary: message.card.subtitle });
      const fresh = deps.store.messagesFor(threadId).find((candidate) => candidate.id === message.id);
      if (fresh?.card && openCard(fresh.card)) settle(threadId, { ...fresh, card: fresh.card }, decision === "accepted" ? "allow" : decision === "rejected" ? "deny" : "unavailable");
      return { ok: true, outcome: outcomeOf(decision) };
    },

    /** `GET /api/bots/:id/edu`. */
    async view(bot: Speaker, mayApprove: boolean): Promise<Omit<EduBrainView, "state" | "mode" | "home" | "brain" | "version" | "reason">> {
      const base = { proposals: [] as EduProposal[], mayApprove: mayApprove && !crewWorker(), ...(crewWorker() ? { crewWorker: true } : {}) };
      if (bot.eduBrain?.mode === "off") return base;
      const brain = await deps.brains.brain(bot);
      if (!brain.ok) return base;
      try {
        const proposals = await list(brain.folder, brain.runtime, bot);
        remember(bot.id, brain.folder, proposals);
        const pending = new Set(proposals.map(eduProposalKey));
        for (const [key, cards] of openCards(brain.folder)) if (!pending.has(key)) for (const card of cards) settle(card.threadId, card.message, "unavailable");
        return { ...base, proposals };
      } catch (error) {
        return { ...base, listError: error instanceof Error ? error.message : String(error) };
      }
    },

    /** `POST /api/bots/:id/edu/proposals/:pid` from Memory settings. */
    async decideFor(bot: Speaker, id: string, approve: boolean): Promise<EduDecision> {
      if (!PROPOSAL_ID.test(id)) return { ok: false, status: 400, error: "That isn't an Edu proposal id." };
      const brain = await deps.brains.brain(bot);
      if (!brain.ok) return { ok: false, status: 409, error: `This bot has no Edu brain right now: ${brain.reason}` };
      const proposals = await list(brain.folder, brain.runtime, bot).catch(() => null);
      if (!proposals) return { ok: false, status: 502, error: "Edu couldn't list the proposals. Try again." };
      remember(bot.id, brain.folder, proposals);
      const proposal = proposals.find((candidate) => candidate.id === id);
      if (!proposal) {
        settleAll(brain.folder, id, "gone", { threadId: "" });
        return { ok: true, outcome: "unavailable" };
      }
      const decision = await decide(brain.folder, id, approve, proposal.global);
      if (typeof decision === "object") return { ok: false, ...decision };
      const threadId = posted.get(eduProposalKey(proposal))?.threadId ?? deps.store.bots.find((candidate) => candidate.id === bot.id)?.threadId ?? "";
      settleAll(brain.folder, id, decision, { threadId, botId: bot.id, botName: bot.name,
        summary: proposalCardWords(proposal, bot.name).subtitle });
      return { ok: true, outcome: outcomeOf(decision) };
    },

    /** Pending proposals as Needs you items, from the last listing; an older listing is refreshed in the background. */
    needsYou(): NeedsYouItem[] {
      if (now() - refreshedAt > REFRESH_MS && !refreshing) {
        refreshedAt = now();
        refreshing = refresh().catch(() => {}).finally(() => { refreshing = null; });
      }
      const items = new Map<string, NeedsYouItem>();
      for (const { botId, proposals } of cache.values()) {
        const bot = deps.store.bot(botId) as (Speaker & { threadId?: string }) | null | undefined;
        if (!bot) continue;
        for (const proposal of proposals) {
          const key = proposal.global ? `global\0${proposal.id}` : eduProposalKey(proposal);
          if (items.has(key)) continue;
          const at = firstSeen.get(eduProposalKey(proposal)) ?? now();
          const card = posted.get(eduProposalKey(proposal));
          items.set(key, { kind: "edu-proposal", id: `edu:${key.replace("\0", ":")}`, at, botId, ...(card ? { threadId: card.threadId } : {}),
            proposalId: proposal.id, title: proposal.title, global: proposal.global });
        }
      }
      return [...items.values()];
    },
  };
}

export type EduProposals = ReturnType<typeof createEduProposals>;

/** Security: who may decide an Edu proposal. A loopback caller may always reject; it may approve only as the desktop
 * app, never as a service. A session needs the admin scope either way. */
export function eduDecisionRefusal(auth: RequestAuth, desktop: boolean, approve: boolean): string | null {
  if (auth.kind === "loopback") {
    if (!approve) return null;
    if (auth.trust === "service") return "A local service can only reject an Edu proposal. Approve it in Edu Bot while signed in.";
    return desktop ? null : "Approve Edu proposals in the Edu Bot desktop app or from a paired device.";
  }
  return auth.scopes.includes("admin") ? null : "Only a workspace admin can decide Edu proposals.";
}
