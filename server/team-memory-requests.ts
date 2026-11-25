// propose_team_memory: a bot's fact for its team, or its removal, applies at once, shown as a one-line notice with Undo.
// In a Cloud turn its owner did not drive, the owner confirms it on a card instead (direct-apply.ts).
import { newId } from "./contracts.ts";
import type { DecisionRow } from "./decision-log.ts";
import { UNDO_STALE, type DirectApply } from "./direct-apply.ts";
import { redactSecretsInText } from "./redact.ts";
import { serverLine } from "./server-lines.ts";
import { TeamMemoryConflict, type TeamMemory, type TeamMemoryEntry, type TeamMemoryInput } from "./team-memory.ts";
import type { OptionCardData } from "../shared/wire.ts";

type Speaker = { id: string; name: string; color: string; section?: string };
type Card = OptionCardData;

export interface TeamMemoryRequestDeps {
  teamMemory: Pick<TeamMemory, "propose" | "resolve" | "resolveProposal" | "undoAccept" | "list" | "findAccepted" | "remove" | "undoRemove">;
  store: {
    messagesFor(threadId: string): Array<{ id: string; card?: Card; from?: { botId: string } }>;
    appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: Card; from?: { botId: string; name: string; color: string } }): { id: string };
    patchMessage(threadId: string, messageId: string, patch: { card: Card }): unknown;
    bot(id: string): { id: string; name: string } | null | undefined;
    botByThread(threadId: string): { id: string; name: string } | null | undefined;
  };
  sectionKey(section: string | undefined): string;
  language(threadId: string): string | undefined;
  decide(row: Omit<DecisionRow, "at">): void;
}

export type TeamMemoryUndo = { claimed: false } | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

const TOOL = "propose_team_memory";
const REASON_MAX = 300;
const FORGET_EXAMPLE = '{"action":"forget","kind":"term","name":"OKR","detail":"Saved in the wrong team."}';

const entrySummary = (entry: Pick<TeamMemoryEntry, "kind" | "name" | "aliases" | "detail">) =>
  `${entry.kind[0].toUpperCase()}${entry.kind.slice(1)}: ${entry.name}${entry.aliases.length ? ` (also ${entry.aliases.join(", ")})` : ""} — ${entry.detail}`;

export function createTeamMemoryRequests(deps: TeamMemoryRequestDeps) {
  const { teamMemory, store } = deps;
  const find = (threadId: string, requestId: string) =>
    store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.teamMemoryRequest);

  /** Allow removes the entry the owner saw on the card, unless it changed since; Keep changes nothing. */
  function answerForget(threadId: string, messageId: string, card: Card, request: NonNullable<Card["teamMemoryRequest"]>, behavior: string,
    proposer: { id: string; name: string } | undefined) {
    if (card.answered) return { ok: true as const, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true as const };
    const allowed = behavior === "allow";
    let removed = false;
    if (allowed) {
      try { removed = teamMemory.remove(request.section, request.entryId, request.revision); }
      catch (error) { if (!(error instanceof TeamMemoryConflict)) throw error; }
      if (!removed) {
        store.patchMessage(threadId, messageId, { card: { ...card, answered: "unavailable", dismissed: true } });
        return { ok: true as const, outcome: "unavailable" };
      }
    }
    store.patchMessage(threadId, messageId, { card: { ...card, answered: allowed ? "allow" : "deny" } });
    deps.decide({ threadId, requestId: card.requestId!, botId: proposer?.id, botName: proposer?.name, tool: TOOL, summary: card.subtitle,
      decision: allowed ? "user-approved" : "user-denied", source: "user" });
    return { ok: true as const, outcome: allowed ? "allowed-once" : "rejected" };
  }

  return {
    /** Throws on invalid input; a conflict with an accepted fact comes back as `error` and saves nothing. */
    submit(from: Speaker, threadId: string, inRoom: boolean, input: TeamMemoryInput, direct: DirectApply | null) {
      const proposed = teamMemory.propose(from.section, input, { botId: from.id, botName: from.name, threadId, at: Date.now() });
      const entry = proposed.entry;
      let revision: string | undefined;
      if (direct) {
        try { teamMemory.resolve(from.section, entry.id, "accept"); }
        catch (error) {
          teamMemory.resolve(from.section, entry.id, "reject");
          if (error instanceof TeamMemoryConflict) return { status: 409, body: { error: error.message } };
          throw error;
        }
        revision = teamMemory.list(from.section).find((candidate) => candidate.id === entry.id)?.revision;
      }
      const summary = entrySummary(entry);
      const message = store.appendMessage(threadId, {
        role: "bot",
        kind: "options",
        ...(inRoom ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
        card: {
          title: direct ? "Remembered for the team" : "Remember this for the team?",
          subtitle: summary,
          options: direct ? [] : ["Remember", "Skip"],
          ...(direct ? { answered: "allow", autoApplied: true } : {}),
          requestId: entry.id,
          tool: TOOL,
          teamMemoryRequest: { section: deps.sectionKey(from.section), entryId: entry.id, kind: entry.kind, ...(revision ? { revision } : {}) },
        },
      });
      deps.decide({ threadId, requestId: entry.id, botId: from.id, botName: from.name, tool: TOOL, summary,
        decision: direct ? "auto-approved" : "card-shown", source: direct ?? "team-memory" });
      return { status: 201, body: { status: direct ? "applied" : "proposed", state: direct ? "applied" : "pending", requestId: entry.id, messageId: message.id, summary } };
    },

    /** Removes an accepted entry of the bot's own team. Nothing is removed when no accepted entry matches. */
    forget(from: Speaker, threadId: string, inRoom: boolean, ref: { key?: string; kind?: string; name?: string }, reason: string, direct: DirectApply | null) {
      const entry = teamMemory.findAccepted(from.section, ref);
      if (!entry) {
        const named = ref.key ? `key ${JSON.stringify(ref.key)}` : `${ref.kind ?? "kind"} ${JSON.stringify(ref.name ?? "")}`;
        return { status: 404, body: { error: `No accepted team memory entry has the ${named}, so nothing was removed. Find it with session_search scope=team, then send its kind, name and key, for example ${FORGET_EXAMPLE}.` } };
      }
      let revision = entry.revision;
      if (direct) {
        try { teamMemory.remove(from.section, entry.id, entry.revision); }
        catch (error) {
          if (error instanceof TeamMemoryConflict) return { status: 409, body: { error: error.message } };
          throw error;
        }
        revision = teamMemory.list(from.section, true).find((candidate) => candidate.id === entry.id)?.revision;
      }
      const why = redactSecretsInText(reason).replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
      const language = deps.language(threadId);
      const summary = why ? serverLine(language, "server.teamMemory.forgetWhy", { entry: entrySummary(entry), why }) : entrySummary(entry);
      const requestId = newId();
      let message: { id: string };
      try {
        message = store.appendMessage(threadId, {
          role: "bot",
          kind: "options",
          ...(inRoom ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
          card: {
            title: serverLine(language, direct ? "server.teamMemory.forgottenTitle" : "server.teamMemory.forgetTitle"),
            subtitle: summary,
            options: direct ? [] : [serverLine(language, "server.teamMemory.forget"), serverLine(language, "server.teamMemory.keep")],
            ...(direct ? { answered: "allow", autoApplied: true } : {}),
            requestId,
            tool: TOOL,
            teamMemoryRequest: { section: deps.sectionKey(from.section), entryId: entry.id, kind: entry.kind, forget: true, ...(revision ? { revision } : {}) },
          },
        });
      } catch (error) {
        // The card is the only receipt and the only Undo, so a removal without a card is put back. Then a retry finds the entry.
        // A failed put-back must not hide the append error, so it is only logged, with the id to restore by hand.
        if (direct && revision) {
          const lost = `team memory: forgotten entry ${entry.id} could not be put back after its card failed`;
          try { if (!teamMemory.undoRemove(from.section, entry.id, revision)) console.error(lost); }
          catch (undoError) { console.error(lost, undoError); }
        }
        throw error;
      }
      deps.decide({ threadId, requestId, botId: from.id, botName: from.name, tool: TOOL, summary,
        decision: direct ? "auto-approved" : "card-shown", source: direct ?? "team-memory" });
      return { status: 201, body: { status: direct ? "applied" : "proposed", state: direct ? "applied" : "pending", requestId, messageId: message.id, summary } };
    },

    /** The owner's answer to a card; null when the request is not a team memory card. */
    resolve(threadId: string, requestId: string, behavior: string): { ok: true; outcome: string; alreadySettled?: true } | null {
      const message = find(threadId, requestId);
      const request = message?.card?.teamMemoryRequest;
      if (!message?.card || !request) return null;
      const proposer = message.from?.botId ? store.bot(message.from.botId) : store.botByThread(threadId);
      if (request.forget) return answerForget(threadId, message.id, message.card, request, behavior, proposer ?? undefined);
      const result = teamMemory.resolveProposal(request.entryId, behavior === "allow" ? "accept" : "reject");
      if (!result.claimed) {
        if (!message.card.answered) store.patchMessage(threadId, message.id, { card: { ...message.card, answered: "unavailable", dismissed: true } });
        return { ok: true, outcome: "unavailable" };
      }
      if (result.state === "already_settled") return { ok: true, outcome: "allowed-once", alreadySettled: true };
      store.patchMessage(threadId, message.id, { card: { ...message.card, answered: result.state === "accepted" ? "allow" : "deny" } });
      deps.decide({ threadId, requestId, botId: proposer?.id, botName: proposer?.name, tool: TOOL, summary: message.card.subtitle,
        decision: result.state === "accepted" ? "user-approved" : "user-denied", source: "user" });
      return { ok: true, outcome: result.state === "accepted" ? "allowed-once" : "rejected" };
    },

    undo(threadId: string, requestId: string): TeamMemoryUndo {
      const message = find(threadId, requestId);
      const card = message?.card;
      const request = card?.teamMemoryRequest;
      if (!message || !card || !request) return { claimed: false };
      if (card.undone) return { claimed: true, state: "already_undone" };
      if (!card.autoApplied || card.answered !== "allow" || !request.revision) {
        return { claimed: true, state: "invalid", error: "Only a change that applied on its own can be undone here.", status: 409 };
      }
      const undone = request.forget ? teamMemory.undoRemove(request.section, request.entryId, request.revision)
        : teamMemory.undoAccept(request.section, request.entryId, request.revision);
      if (!undone) {
        return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      }
      store.patchMessage(threadId, message.id, { card: { ...card, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}
