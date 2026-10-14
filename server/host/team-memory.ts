import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { CaptureBatch, Candidate, CaptureTurn } from "../memory-capture.ts";
import { sameAudience } from "../bot-visibility.ts";
import { sectionContextKey, sectionMemoryKey } from "../section-context.ts";
import type { TeamMemory, TeamMemoryInput } from "../team-memory.ts";
import { recordProjectEvidence, type EvidenceInput } from "../project-evidence.ts";

export function createTeamMemoryActions(deps: {
  store: Pick<Store, "bot" | "groupByThread" | "taskByThread" | "appendMessage">;
  memory: () => TeamMemory;
  mayCapture: (botId: string, threadId: string) => boolean;
  roomFeedsBot: (room: GroupRecord, bot: BotRecord) => boolean;
}) {
  const { store } = deps;
  return {
    mayCapture: deps.mayCapture,
    capture(batch: CaptureBatch, candidate: Candidate, turn: CaptureTurn) {
      const bot = store.bot(batch.botId);
      const room = store.groupByThread(batch.threadId);
      if ((!room && !turn.delegated) || !bot || !deps.mayCapture(bot.id, batch.threadId) || !sameAudience(bot.visibility, undefined)
        || (room && sectionContextKey(room.section) !== sectionContextKey(bot.section))) return;
      const memory = deps.memory();
      const kind = candidate.kind === "lesson" ? "lesson" : candidate.kind === "question" ? "question" : candidate.kind === "outcome" ? "outcome" : "decision";
      if (memory.list(bot.section, true).some(entry => entry.detail === candidate.text && entry.kind === kind)) return;
      const sourceLine = turn.room?.find(line => candidate.sourceQuote && line.text.replace(/\s+/g, " ").includes(candidate.sourceQuote.replace(/\s+/g, " ")));
      const result = memory.propose(bot.section, { kind, name: candidate.teamName!, detail: candidate.text, key: candidate.key },
        { botId: bot.id, botName: bot.name, threadId: batch.threadId, at: Date.now(), messageId: sourceLine?.messageId ?? turn.sourceMessageId, turnId: turn.turnId, quote: candidate.sourceQuote });
      store.appendMessage(batch.threadId, { role: "bot", kind: "options", from: { botId: bot.id, name: bot.name, color: bot.color },
        card: { title: "Remember this for the team?", subtitle: `${result.entry.name} — ${result.entry.detail}`, options: ["Remember", "Skip"], requestId: result.entry.id,
          tool: "propose_team_memory", teamMemoryRequest: { section: bot.section ?? "", entryId: result.entry.id, kind } } });
    },
    async propose(input: TeamMemoryInput & { fromThreadId: string; evidence?: EvidenceInput }, from: BotRecord, assertActive: () => void, turnId?: string) {
      const room = store.groupByThread(input.fromThreadId);
      const folderFor = () => room?.cwd ?? store.taskByThread(from.id, input.fromThreadId)?.cwd ?? from.cwd;
      const folder = folderFor();
      if (input.evidence && (!folder || input.kind !== "outcome")) throw new Error("Project evidence requires an outcome and a conversation working folder");
      const key = sectionMemoryKey(from.section);
      const evidence = input.evidence ? await recordProjectEvidence(folder!, input.evidence) : undefined;
      assertActive();
      if (sectionMemoryKey(from.section) !== key || !sameAudience(from.visibility, undefined) || (room && !deps.roomFeedsBot(room, from))) throw new Error("Team or audience changed while recording evidence; retry");
      if (input.evidence && folderFor() !== folder) throw new Error("Working folder changed while recording evidence; retry");
      return deps.memory().propose(from.section, input, { botId: from.id, botName: from.name, threadId: input.fromThreadId, at: Date.now(), turnId }, evidence);
    },
  };
}
