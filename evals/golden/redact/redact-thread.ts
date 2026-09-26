import { z } from "zod";
import { scenarioSchema, type Assertion, type Scenario, type ScriptedToolCall, type Step } from "../../types.ts";
import { formatFindings, scanSerialized, scanStrings, survivorsOf } from "./leak-scan.ts";

/** Tier 2, step one: an in-repo redaction step that turns a real thread
 * export into a synthetic tier-1 scenario fixture. The input is the exact
 * shape the product serves at /api/threads/<id>/messages (plus the thread
 * owner's display name and optional handoff participants), never a live
 * store. The output is pure scenario data that replays through the mock
 * provider; no real content survives into it.
 *
 * Redaction rules:
 * - participant names/ids become synthetic keys (@bot1, @bot2, ...)
 * - user and bot text become positional placeholders (<user message 1>)
 * - tool arguments keep their key structure; values become type-preserving
 *   placeholders, except values that name a participant, which become bot
 *   references so coordinate_bots replay still dispatches
 * - timestamps, ids, attachments and every other message field are dropped
 * - the serialized fixture is scanned for sensitive patterns, and every
 *   source string of length >= 8 is proven absent, before anything is
 *   returned; a leak aborts the redaction with the pattern categories. */

export const REDACTOR_VERSION = 1;

const TERMINAL_HANDOFF_STATUSES = new Set(["completed", "failed"]);

export const goldenExportSchema = z.object({
  meta: z.object({
    /** The scenario id the redacted fixture will carry. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "scenario id must be kebab-case"),
    title: z.string().optional(),
    /** One sentence stating the behavior the golden thread pins. */
    behavior: z.string().optional(),
    /** Optional participant table so id-valued tool arguments (for example
     * bot_ids carrying live uuids) can be mapped to synthetic references. */
    participants: z.array(z.object({ name: z.string(), id: z.string().optional() })).optional(),
  }),
  /** Display name of the bot whose thread was exported. */
  bot: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(["user", "bot"]),
      kind: z.string(),
      text: z.string().optional(),
      tool: z.object({ name: z.string().optional(), arguments: z.record(z.string(), z.unknown()).optional() }).optional(),
    }),
  ),
  /** Optional handoff nodes; display-name keyed. Only all-terminal trees
   * are pinned (replay drives every node to a terminal status). */
  handoffs: z.array(z.object({ bot: z.string(), status: z.string(), hasParent: z.boolean().optional() })).optional(),
});

export type GoldenThreadExport = z.infer<typeof goldenExportSchema>;

export interface RedactionReport {
  scenarioId: string;
  participants: number;
  messagesIn: number;
  userMessages: number;
  turnsDerived: number;
  toolCallsDerived: number;
  /** Replies synthesized for handoff bots whose real replies live outside
   * the exported thread. */
  synthesizedReplies: number;
  handoffsPinned: boolean;
  handoffsOmittedReason?: string;
  sourceStringsChecked: number;
  leaks: string[];
}

export interface RedactionResult {
  scenario: Scenario;
  /** The fixture exactly as it must be serialized (stable key order). */
  serialized: string;
  report: RedactionReport;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableStringify((value as Record<string, unknown>)[key]))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

function serializeFixture(scenario: Scenario): string {
  return JSON.stringify(JSON.parse(stableStringify(scenario)), null, 2) + "\n";
}

const ORDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

class ParticipantMap {
  private readonly byName = new Map<string, string>();
  private readonly byId = new Map<string, string>();
  private readonly keys: string[] = [];
  private readonly names: string[] = [];

  add(name: string, id?: string): string {
    const existing = this.byName.get(name);
    if (existing !== undefined) return existing;
    const index = this.keys.length + 1;
    const key = "bot" + index;
    this.keys.push(key);
    this.names.push("Golden " + (ORDINALS[index - 1] ?? index));
    this.byName.set(name, key);
    if (id !== undefined) this.byId.set(id, key);
    return key;
  }

  keyOf(value: string): string | undefined {
    return this.byName.get(value) ?? this.byId.get(value);
  }

  keyList(): string[] {
    return [...this.keys];
  }

  nameList(): string[] {
    return [...this.names];
  }
}

/** Argument skeleton: keys stay (they are tool schema, not user data),
 * values become type-preserving placeholders; participant references map
 * to @bot keys so replay dispatches to the synthetic bots. */
function skeletonArguments(args: Record<string, unknown> | undefined, participants: ParticipantMap): Record<string, unknown> {
  if (args === undefined) return {};
  const skeleton = (value: unknown, depth: number): unknown => {
    if (depth > 6) return "<redacted>";
    if (typeof value === "string") {
      const key = participants.keyOf(value);
      return key === undefined ? "<redacted>" : "@" + key;
    }
    if (typeof value === "number") return 0;
    if (Array.isArray(value)) {
      const mapped = value.map((entry) => skeleton(entry, depth + 1));
      const unique = [...new Set(mapped.map((entry) => JSON.stringify(entry)))];
      return unique.map((entry) => JSON.parse(entry) as unknown);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, skeleton(entry, depth + 1)]));
    }
    return value;
  };
 return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      // coordinate_bots validates request_key as [\\w-]{1,100} server-side;
      // a markup placeholder would be refused and the recorded dispatch
      // could never replay. The key is an opaque slug, never content worth
      // preserving, so it always becomes the same replay-safe placeholder.
      if (key === "request_key") return [key, "redacted-request"];
      return [key, skeleton(value, 0)];
    }),
  );
}

/** Participant references (@botN) inside a coordinate_bots call's skeleton
 * arguments, in order of first appearance: the bots replay will dispatch
 * to, whose turns interleave with the owner's in the evidence log. */
function collectParticipantRefs(value: unknown): string[] {
  if (typeof value === "string") {
    return /^@bot\d+$/.test(value) ? [value.slice(1)] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => collectParticipantRefs(entry));
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectParticipantRefs(entry));
  }
  return [];
}

interface DerivedTurn {
  botKey: string;
  steps: ScriptedToolCall[];
  reply?: string;
}

function collectSourceTexts(exported: GoldenThreadExport): string[] {
  const texts: string[] = [exported.bot];
  for (const participant of exported.meta.participants ?? []) texts.push(participant.name);
  for (const handoff of exported.handoffs ?? []) texts.push(handoff.bot);
  for (const message of exported.messages) {
    if (message.text !== undefined) texts.push(message.text);
    if (message.tool?.arguments !== undefined) {
      for (const value of Object.values(message.tool.arguments)) {
        if (typeof value === "string") texts.push(value);
      }
    }
  }
  return texts;
}

export function redactThread(exported: GoldenThreadExport): RedactionResult {
  const participants = new ParticipantMap();
  const ownerKey = participants.add(exported.bot);
  for (const participant of exported.meta.participants ?? []) participants.add(participant.name, participant.id);
  for (const handoff of exported.handoffs ?? []) participants.add(handoff.bot);

  const steps: Step[] = [];
  const turns: DerivedTurn[] = [];
  let userMessageCount = 0;
  let replyCount = 0;
  let openTurn: DerivedTurn | undefined;
  const closeTurn = () => {
    if (openTurn !== undefined) turns.push(openTurn);
    openTurn = undefined;
  };

  for (const message of exported.messages) {
    if (message.role === "user" && message.kind === "text" && message.text !== undefined && message.text.trim() !== "") {
      closeTurn();
      userMessageCount += 1;
      steps.push({ kind: "send", bot: ownerKey, text: "<user message " + userMessageCount + ">" });
      continue;
    }
    if (message.role === "bot") {
      if (message.kind === "activity" && message.tool?.name !== undefined) {
        openTurn ??= { botKey: ownerKey, steps: [] };
        openTurn.steps.push({
          tool: message.tool.name,
          arguments: skeletonArguments(message.tool.arguments, participants),
        });
        continue;
      }
      if (message.kind === "text" && message.text !== undefined && message.text.trim() !== "") {
        replyCount += 1;
        const placeholder = "<reply " + replyCount + ">";
        if (openTurn === undefined) openTurn = { botKey: ownerKey, steps: [] };
        openTurn.reply = placeholder;
        closeTurn();
      }
    }
  }
  closeTurn();

  // Handoff pins only when the exported tree is all-terminal; a live tree
  // would not reproduce its exported statuses under replay.
  const handoffs = exported.handoffs ?? [];
  const handoffsPinned = handoffs.length > 0 && handoffs.every((node) => TERMINAL_HANDOFF_STATUSES.has(node.status));
  const handoffsOmittedReason = handoffs.length === 0
    ? "export carried no handoff nodes"
    : handoffsPinned
      ? undefined
      : "exported handoff tree had non-terminal statuses; replay would drift";

  // Waits are state-based only: after every send, the owner goes idle; at
  // the end, each pinned handoff bot reaches its exported terminal status.
  // Exact turn-count waits are deliberately absent: when a handoff settles,
  // the harness wakes the coordinator with one extra turn, so replay turn
  // counts depend on that behavior rather than the export's shape.
  const waitSteps: Step[] = [];
  let pendingSend = false;
  for (const step of steps) {
    if (step.kind !== "send") continue;
    if (pendingSend) waitSteps.push({ kind: "waitForBusy", bot: ownerKey, busy: false, timeoutMs: 20_000 });
    waitSteps.push(step);
    pendingSend = true;
  }
  waitSteps.push({ kind: "waitForBusy", bot: ownerKey, busy: false, timeoutMs: 20_000 });
  if (handoffsPinned) {
    for (const node of handoffs) {
      const key = participants.keyOf(node.bot);
      if (key === undefined || key === ownerKey) continue;
      waitSteps.push({ kind: "waitForNodeStatus", bot: key, status: node.status, timeoutMs: 20_000 });
    }
    const ownerStatus = handoffs.find((node) => participants.keyOf(node.bot) === ownerKey)?.status ?? "completed";
    waitSteps.push({ kind: "waitForNodeStatus", bot: ownerKey, status: ownerStatus, timeoutMs: 20_000 });
  }

  // Bots: the owner plus every other participant the pinned tree or the
  // declared participants mention. Non-owner bots get one synthesized
  // placeholder turn so a replayed dispatch completes.
  const keys = participants.keyList();
  const names = participants.nameList();
  const bots = keys.map((key, index) => {
    if (key !== ownerKey) return { key, name: names[index], turns: [{ reply: "<synthesized reply " + key + ">" }] };
    return {
      key,
      name: names[index],
      turns: turns
        .filter((turn) => turn.botKey === ownerKey)
        .map((turn) => ({
          ...(turn.steps.length === 0 ? {} : { steps: turn.steps }),
          ...(turn.reply === undefined ? {} : { reply: turn.reply }),
        }))
        // When a handoff settles, the harness wakes the coordinator with
        // one more turn. A real export usually already contains that reply;
        // the spare scripted turn covers exports that ended before it.
        .concat(handoffsPinned ? [{ reply: "<settled reply>" }] : []),
    };
  });
  const synthesizedReplies = bots.filter((bot) => bot.key !== ownerKey).length;

  // turnOrder is pinned only for single-send threads, and as the replay's
  // room-wide order: the owner's turn, then one turn per bot the owner's
  // coordinate_bots calls dispatch to (each dispatched bot's scripted turn
  // runs as its handoff completes), then the owner's wake turn. The
  // scripted engine's evidence log is room-wide, so pinning only the
  // exported owner turns would compare two different sequences. Multi-send
  // histories interleave steering and wakes in orders replay cannot pin
  // without the real timing, so they assert traces and outcomes instead.
  const dispatchedKeys = [
    ...new Set(
      turns
        .flatMap((turn) => turn.steps)
        .filter((call) => (call.tool ?? "coordinate_bots") === "coordinate_bots")
        .flatMap((call) => collectParticipantRefs(call.arguments)),
    ),
  ];
  const assertions: Assertion[] = [];
  if (userMessageCount === 1) {
    assertions.push({
      kind: "turnOrder",
      bots: dispatchedKeys.length > 0 ? [ownerKey, ...dispatchedKeys, ownerKey] : [ownerKey],
    });
  }
  assertions.push(
    ...keys
      .filter((key) => turns.some((turn) => turn.botKey === key && turn.steps.length > 0))
      .map((key) => ({
        kind: "toolNames" as const,
        bot: key,
        equals: turns
          .filter((turn) => turn.botKey === key)
          .flatMap((turn) => turn.steps.map((call) => call.tool ?? "coordinate_bots")),
      })),
  );
  const lastReply = [...turns].reverse().find((turn) => turn.reply !== undefined)?.reply;
  if (lastReply !== undefined) {
    assertions.push({ kind: "transcriptIncludes", bot: ownerKey, thread: "active" as const, text: lastReply });
  }
  if (handoffsPinned) {
    assertions.push({
      kind: "handoffTree",
      equals: handoffs.map((node) => {
        const key = participants.keyOf(node.bot);
        return {
          bot: key ?? node.bot,
          status: node.status,
          ...(node.hasParent === undefined ? {} : { hasParent: node.hasParent }),
        };
      }),
    });
  }

  const scenario: Scenario = {
    id: exported.meta.id,
    title: exported.meta.title ?? "Golden replay of a redacted real thread",
    behavior: exported.meta.behavior ?? "The redacted golden thread replays its recorded tool trace and outcome unchanged.",
    world: "coordination",
    gates: [],
    bots,
    steps: waitSteps,
    assertions,
    golden: { from: "redacted-thread", redactor: REDACTOR_VERSION },
  };

  const serialized = serializeFixture(scenario);
  scenarioSchema.parse(JSON.parse(serialized));

  const leaks = [...scanStrings(JSON.parse(serialized)), ...scanSerialized(serialized)];
  if (leaks.length > 0) {
    throw new Error("redaction leaked sensitive patterns: " + formatFindings(leaks));
  }
  const sourceTexts = collectSourceTexts(exported);
  const survivors = survivorsOf(sourceTexts, serialized);
  if (survivors.length > 0) {
    throw new Error("redaction left " + survivors.length + " source string(s) intact in the fixture");
  }

  const toolCallsDerived = turns.reduce((total, turn) => total + turn.steps.length, 0);
  return {
    scenario,
    serialized,
    report: {
      scenarioId: scenario.id,
      participants: keys.length,
      messagesIn: exported.messages.length,
      userMessages: userMessageCount,
      turnsDerived: turns.length,
      toolCallsDerived,
      synthesizedReplies,
      handoffsPinned,
      ...(handoffsOmittedReason === undefined ? {} : { handoffsOmittedReason }),
      sourceStringsChecked: sourceTexts.length,
      leaks: [],
    },
  };
}
