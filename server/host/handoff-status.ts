// Where work one bot handed another stands, shown where people already look: on the "Sent to" row in the asking
// conversation, and on the conversation that does the work (the inbox lists it). Read from the assignment records each
// time they are written; nothing is added to them.
//
// Security: the row is one stored message that everyone who reads the asking conversation sees. It carries a state, a
// bot's name, and on a Team Cloud the asker's name; never the work's words, its question or, when the work runs in a
// person's private chat that the row's readers can't open, that chat's title.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { HandoffState, HandoffStatusLine } from "../../shared/handoff-status.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { HandoffView } from "../coordinator.ts";
import type { Store } from "../store.ts";
import { oneLine } from "./text-clip.ts";

export const HANDOFF_LINES_FILE = "handoff-lines.json";
const WHY_MAX = 160;
/** Ended lines the work conversations still show, newest kept. */
const ENDED_KEPT = 200;

const id = z.string().min(1).max(200);
const trackedSchema = z.object({ id, threadId: id, messageId: id, workThreadId: id, workBotId: id });
const fileSchema = z.object({ version: z.literal(1), lines: z.array(trackedSchema) });
type Tracked = z.infer<typeof trackedSchema> & { line?: HandoffStatusLine };

export type HandoffNode = Pick<HandoffView, "id" | "status" | "botId" | "threadId" | "parentId" | "question" | "cards" | "outcome" | "outcomeDetail" | "result" | "origin">;

export interface HandoffLineFacts {
  /** The bots it waits on, by name. */
  waitingBots: string[];
  /** On a Team Cloud: the asker's name, and whether the work runs in their private chat while the row is somewhere they don't own. */
  forPerson?: { name: string; private?: true };
  /** On a Team Cloud, the person a question waits on; off a team, none ("you"). */
  askedPerson?: string;
}

const stateOf = (node: Pick<HandoffNode, "status">): HandoffState => {
  switch (node.status) {
    case "queued": return "claimed";
    case "waiting": return "waiting";
    case "completed": return "done";
    case "failed":
    case "cancelled": return "failed";
    default: return "working";
  }
};

function whyFailed(node: HandoffNode): string {
  if (node.status === "cancelled" && node.outcome === "stopped") return "Stopped";
  return oneLine(node.outcomeDetail || node.result || (node.status === "cancelled" ? "Cancelled" : "Failed"), WHY_MAX);
}

/** The status line for one hand-off, from its record and what the host knows around it. */
export function handoffLine(node: HandoffNode, facts: HandoffLineFacts, at: number): HandoffStatusLine {
  const state = stateOf(node);
  const line: HandoffStatusLine = { id: node.id, state, at };
  if (state === "waiting") {
    const onPerson = Boolean(node.question || node.cards?.length) || facts.waitingBots.length === 0;
    line.waitingOn = onPerson
      ? { kind: "person", ...(facts.askedPerson ? { name: facts.askedPerson } : {}) }
      : { kind: "bot", name: facts.waitingBots.length > 2 ? `${facts.waitingBots.slice(0, 2).join(", ")} +${facts.waitingBots.length - 2}` : facts.waitingBots.join(", ") };
  }
  if (state === "failed" && !facts.forPerson?.private) line.why = whyFailed(node);
  if (facts.forPerson) line.forPerson = facts.forPerson;
  return line;
}

const sameLine = (a: HandoffStatusLine | undefined, b: HandoffStatusLine) =>
  a !== undefined && a.state === b.state && a.why === b.why && JSON.stringify(a.waitingOn) === JSON.stringify(b.waitingOn)
  && JSON.stringify(a.forPerson) === JSON.stringify(b.forPerson);

const ended = (line: HandoffStatusLine) => line.state === "done" || line.state === "failed";

export interface HandoffStatusDeps {
  dataDir: string;
  now?: () => number;
  node(id: string): HandoffNode | undefined;
  /** Its open hand-offs: the work it waits on. */
  children(node: HandoffNode): HandoffNode[];
  botName(botId: string): string | undefined;
  /** On a Team Cloud: a person's name by key, and the person a conversation is private to. Absent off a team. */
  team?: { personName(person: string): string | undefined; privateTo(threadId: string): string | null };
  store: Pick<Store, "messagesFor" | "patchMessage">;
  /** The work conversation's bot changed what it shows: publish it again. */
  republish(botId: string): void;
  log?(text: string): void;
}

export function createHandoffStatus(deps: HandoffStatusDeps) {
  const file = join(deps.dataDir, HANDOFF_LINES_FILE);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((text: string) => console.error(text));
  const tracked = new Map<string, Tracked>();
  const byWork = new Map<string, HandoffStatusLine>();
  let scheduled = false;

  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) for (const row of parsed.data.lines) tracked.set(row.id, row);
  } catch { /* none yet */ }

  function save(): void {
    try {
      writeFileAtomic(file, JSON.stringify({ version: 1, lines: [...tracked.values()].map(({ line: _line, ...row }) => row) }), { mode: 0o600 });
    } catch (error) {
      log(`handoff status: could not save: ${String(error)}`);
    }
  }

  function facts(node: HandoffNode, row: Pick<Tracked, "threadId">): HandoffLineFacts {
    const waitingBots = node.status === "waiting" ? deps.children(node).filter((child) => child.status !== "completed" && child.status !== "failed" && child.status !== "cancelled")
      .map((child) => deps.botName(child.botId) ?? "a teammate") : [];
    const team = deps.team;
    const person = node.origin?.kind === "user" ? node.origin.person : undefined;
    if (!team || !person) return { waitingBots };
    const name = team.personName(person);
    if (!name) return { waitingBots };
    const privateWork = team.privateTo(node.threadId) === person && team.privateTo(row.threadId) !== person;
    return { waitingBots, forPerson: { name, ...(privateWork ? { private: true as const } : {}) }, askedPerson: name };
  }

  function show(row: Tracked, line: HandoffStatusLine): void {
    try {
      const message = deps.store.messagesFor(row.threadId).find((candidate) => candidate.id === row.messageId);
      if (message) {
        const hideTitle = line.forPerson?.private === true && message.threadRef?.title;
        deps.store.patchMessage(row.threadId, row.messageId, { handoff: line, ...(hideTitle ? { threadRef: { ...message.threadRef!, title: "" } } : {}) });
      }
    } catch (error) {
      log(`handoff status ${row.id}: could not update its row: ${String(error)}`);
    }
    byWork.set(row.workThreadId, line);
    if (byWork.size > ENDED_KEPT + tracked.size) {
      for (const [thread, kept] of byWork) {
        if (byWork.size <= ENDED_KEPT + tracked.size) break;
        if (ended(kept)) byWork.delete(thread);
      }
    }
    try { deps.republish(row.workBotId); } catch (error) { log(`handoff status ${row.id}: could not publish: ${String(error)}`); }
  }

  function refresh(): void {
    let changed = false;
    for (const row of tracked.values()) {
      const node = deps.node(row.id);
      if (!node) {
        tracked.delete(row.id);
        changed = true;
        continue;
      }
      const next = handoffLine(node, facts(node, row), now());
      if (sameLine(row.line, next)) continue;
      if (row.line && row.line.state === next.state) next.at = row.line.at;
      row.line = next;
      show(row, next);
      if (ended(next)) {
        tracked.delete(row.id);
        changed = true;
      }
    }
    if (changed) save();
  }

  return {
    /** A "Sent to" row was written for this hand-off. */
    track(assignmentId: string, threadId: string, messageId: string): void {
      const node = deps.node(assignmentId);
      if (!node) return;
      tracked.set(assignmentId, { id: assignmentId, threadId, messageId, workThreadId: node.threadId, workBotId: node.botId });
      save();
      refresh();
    },
    /** The assignment records were written: look again, once, after the write settles. */
    changed(): void {
      if (scheduled || !tracked.size) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        try { refresh(); } catch (error) { log(`handoff status: ${String(error)}`); }
      });
    },
    refresh,
    /** The status of the hand-off a work conversation is doing, for its task row. */
    forWork(threadId: string): { handoff: HandoffStatusLine } | Record<string, never> {
      const line = byWork.get(threadId);
      return line ? { handoff: line } : {};
    },
    tracking(): string[] {
      return [...tracked.keys()];
    },
  };
}

export type HandoffStatus = ReturnType<typeof createHandoffStatus>;
