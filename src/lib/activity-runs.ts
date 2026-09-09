// Grouping a transcript's tool chips into runs.
//
// A bot working through a task emits one chip per tool call, and a long
// stretch of them buries the thing you actually came to read: what the bot
// SAID. Consecutive finished steps fold into a single row that names them;
// text between two stretches breaks the run, so the bot's words always
// separate one run from the next.
import type { Message } from "@/state/store";
import { formatElapsed } from "@/lib/working-time";
import { t } from "@/lib/i18n";

export type ActivityTranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

export type TranscriptItem =
  | ActivityTranscriptItem
  | { kind: "turn"; id: string; turnId: string; label: string; messages: Message[] };

/** A step that may be folded away: finished, a real tool, and not a
 * bot⇄bot or opened-thread chip (those are navigation, not work) or a
 * failed turn (that renders as an error). A step still running stays out,
 * so live progress is never hidden behind a fold. */
function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef) return false;
  if (tool.ok !== true) return false;
  return !tool.name.startsWith("error:");
}

type TurnFold = Extract<TranscriptItem, { kind: "turn" }>;

/** Settled providers may emit several ordinary assistant messages around
 * tool calls. Keep the terminal answer in the transcript and replace the
 * earlier narration with one reversible row, matching T3 Code's turn fold. */
function assistantTurnFolds(messages: Message[]): {
  byAnchorId: Map<string, TurnFold>;
  hiddenIds: Set<string>;
} {
  const byAnchorId = new Map<string, TurnFold>();
  const hiddenIds = new Set<string>();

  messages.forEach((terminal, terminalIndex) => {
    if (
      terminal.role !== "bot" ||
      terminal.kind !== "text" ||
      !terminal.turnId ||
      !terminal.turnTerminal
    ) return;

    const narration = messages.slice(0, terminalIndex).filter((message) =>
      message.role === "bot" &&
      message.kind === "text" &&
      message.turnId === terminal.turnId &&
      !message.turnTerminal
    );
    if (!narration.length) return;

    const anchor = narration[0];
    const anchorIndex = messages.findIndex((message) => message.id === anchor.id);
    let startedAt = anchor.at;
    for (let i = anchorIndex - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        startedAt = messages[i].at;
        break;
      }
    }
    const elapsed = Math.max(0, terminal.at - startedAt);
    const label =
      elapsed >= 1_000
        ? t("chat.run.workedFor", { elapsed: formatElapsed(elapsed) })
        : t("chat.run.worked");
    const fold: TurnFold = {
      kind: "turn",
      id: `turn:${terminal.turnId}`,
      turnId: terminal.turnId,
      label,
      messages: narration,
    };
    byAnchorId.set(anchor.id, fold);
    for (const message of narration) hiddenIds.add(message.id);
  });

  return { byAnchorId, hiddenIds };
}

function group(messages: Message[], foldAssistantTurns: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const folds = foldAssistantTurns
    ? assistantTurnFolds(messages)
    : { byAnchorId: new Map<string, TurnFold>(), hiddenIds: new Set<string>() };
  let run: Message[] = [];
  const flush = () => {
    // one step on its own is cheaper to read than a fold that hides it
    if (run.length > 1) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    const turn = folds.byAnchorId.get(message.id);
    if (turn) {
      flush();
      items.push(turn);
      continue;
    }
    if (folds.hiddenIds.has(message.id)) continue;
    if (foldable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          new Date(first.at).toDateString() !== new Date(message.at).toDateString())
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

export function groupActivityRuns(messages: Message[]): ActivityTranscriptItem[] {
  return group(messages, false) as ActivityTranscriptItem[];
}

export function groupTranscript(messages: Message[]): TranscriptItem[] {
  return group(messages, true);
}

const MAX_NAMES = 3;

/** The one line a folded run has to earn its place with: how much work it
 * was and which tools did it. Failed steps are never folded. */
export function describeRun(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const name = message.tool?.name ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length > MAX_NAMES ? ` ${t("chat.run.more", { count: names.length - MAX_NAMES })}` : "";
  return t("chat.run.steps", { count: messages.length, tools: `${shown}${rest}` });
}
