// propose_team_memory: a bot's fact for its team applies at once, shown as a one-line notice with Undo. In a Cloud turn
// its owner did not drive, the owner confirms it on a card instead (direct-apply.ts).
import type { DecisionRow } from "./decision-log.ts";
import { UNDO_STALE, type DirectApply } from "./direct-apply.ts";
import { TeamMemoryConflict, type TeamMemory, type TeamMemoryInput } from "./team-memory.ts";
import type { OptionCardData } from "../shared/wire.ts";

type Speaker = { id: string; name: string; color: string; section?: string };
type Card = OptionCardData;

export interface TeamMemoryRequestDeps {
  teamMemory: Pick<TeamMemory, "propose" | "resolve" | "resolveProposal" | "undoAccept" | "list">;
  store: {
    messagesFor(threadId: string): Array<{ id: string; card?: Card; from?: { botId: string } }>;
    appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: Card; from?: { botId: string; name: string; color: string } }): { id: string };
    patchMessage(threadId: string, messageId: string, patch: { card: Card }): unknown;
    bot(id: string): { id: string; name: string } | null | undefined;
    botByThread(threadId: string): { id: string; name: string } | null | undefined;
  };
  sectionKey(section: string | undefined): string;
  decide(row: Omit<DecisionRow, "at">): void;
}

export type TeamMemoryUndo = { claimed: false } | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

const TOOL = "propose_team_memory";

export function createTeamMemoryRequests(deps: TeamMemoryRequestDeps) {
  const { teamMemory, store } = deps;
  const find = (threadId: string, requestId: string) =>
    store.messagesFor(threadId).find((message) => message.card?.requestId === requestId && message.card.teamMemoryRequest);

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
      const summary = `${entry.kind[0].toUpperCase()}${entry.kind.slice(1)}: ${entry.name}${entry.aliases.length ? ` (also ${entry.aliases.join(", ")})` : ""} — ${entry.detail}`;
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

    /** The owner's answer to a card; null when the request is not a team memory card. */
    resolve(threadId: string, requestId: string, behavior: string): { ok: true; outcome: string; alreadySettled?: true } | null {
      const message = find(threadId, requestId);
      const request = message?.card?.teamMemoryRequest;
      if (!message?.card || !request) return null;
      const proposer = message.from?.botId ? store.bot(message.from.botId) : store.botByThread(threadId);
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
      if (!teamMemory.undoAccept(request.section, request.entryId, request.revision)) {
        return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      }
      store.patchMessage(threadId, message.id, { card: { ...card, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}
