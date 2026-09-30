// The decision model's first job: who answers a room message nobody was
// @mentioned in, for rooms set to "Auto".
//
// One Choice over the room's active bots, keyed by bot id and described by
// name, title and description, plus __everyone__ for a message that needs
// several members. The state is the room, its people, the last room lines
// and the new message: the shape that routed 53 of 53 bench messages.
//
// Acting on it: a bot or __everyone__ at p >= 0.6 answers; anything less
// sure, and any failure at all, falls back to the room's lead (or its first
// member), which is exactly what a lead-mode room does today. Nothing here
// throws.
import type { Decider } from "./index.ts";
import type { DeciderFailure } from "./types.ts";

/** Turn starts take seconds anyway, and people far from the US West Coast
 * see 400–700 ms round trips; 1.5 s keeps a slow answer usable. */
export const ROOM_ROUTING_TIMEOUT_MS = 1_500;
/** Bench calibration: answers at >= 0.6 were right 92–99% of the time. */
export const ROOM_ROUTING_MIN_PROBABILITY = 0.6;
export const EVERYONE_OPTION = "__everyone__";
const EVERYONE_MEANING = "Several members: the message explicitly needs answers or work from more than one member of the room, for example it asks everyone or asks each member for their part.";
/** Fixed: Cloud Pro's decision relay accepts room routing only with these
 * exact instructions (relay.ts). */
export const ROOM_ROUTING_INSTRUCTIONS = "Which bot in this room should answer `new_message`? Choose __everyone__ only when the message needs several members to answer.";
/** Every key the state may carry; `recent_messages` is left out when there
 * are none. Cloud Pro's relay accepts no other. */
export const ROOM_ROUTING_STATE_KEYS = ["room", "humans_in_room", "bots_in_room", "recent_messages", "new_message"] as const;

const NAME_MAX = 80;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 400;
const LINE_MAX = 500;
/** The room context window bounds how many lines; this bounds their size,
 * because large irrelevant state makes the classifier worse, not better. */
const RECENT_BUDGET_CHARS = 6_000;

export interface RoomRoutingMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
}

export interface RoomRoutingInput {
  room: string;
  humans: string[];
  /** Active members only, in room order. */
  members: RoomRoutingMember[];
  /** Oldest first; already limited to the room's context window. */
  recent: Array<{ from: string; text: string }>;
  message: { from: string; text: string };
}

export type RoomRoute =
  | { kind: "member"; botId: string; probability: number }
  | { kind: "everyone"; probability: number }
  | { kind: "fallback"; reason: DeciderFailure | "low_confidence" | "no_choice" };

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What one bot is, as an option: "Maya, Product Designer. Owns UI…". */
export function memberOption(member: RoomRoutingMember): string {
  const name = clip(member.name, NAME_MAX) || "Unnamed bot";
  const title = member.title ? clip(member.title, TITLE_MAX) : "";
  const description = member.description ? clip(member.description, DESCRIPTION_MAX) : "";
  return `${name}${title ? `, ${title}` : ""} bot.${description ? ` ${description}` : ""}`;
}

/** The newest lines that fit the budget, oldest first, each clipped. */
function recentWithinBudget(recent: RoomRoutingInput["recent"]): RoomRoutingInput["recent"] {
  const kept: RoomRoutingInput["recent"] = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    const line = recent[index]!;
    const text = clip(line.text, LINE_MAX);
    if (!text) continue;
    const size = text.length + line.from.length;
    if (used + size > RECENT_BUDGET_CHARS) break;
    used += size;
    kept.unshift({ from: clip(line.from, NAME_MAX), text });
  }
  return kept;
}

export function roomRoutingRequest(input: RoomRoutingInput) {
  const options: Record<string, string> = {};
  for (const member of input.members) options[member.id] = memberOption(member);
  options[EVERYONE_OPTION] = EVERYONE_MEANING;
  const recent = recentWithinBudget(input.recent);
  const state = {
    room: clip(input.room, NAME_MAX),
    humans_in_room: input.humans.map((human) => clip(human, NAME_MAX)),
    bots_in_room: input.members.map((member) => clip(member.name, NAME_MAX)),
    ...(recent.length ? { recent_messages: recent } : {}),
    new_message: { from: clip(input.message.from, NAME_MAX), text: input.message.text.trim().slice(0, 8_000) },
  };
  return { state, question: { instructions: ROOM_ROUTING_INSTRUCTIONS, options } };
}

/** Ask once and turn the answer into a route. Never throws. */
export async function decideRoomResponder(
  decider: Pick<Decider, "choose">,
  input: RoomRoutingInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RoomRoute> {
  try {
    if (input.members.length < 2) return { kind: "fallback", reason: "no_choice" };
    const { state, question } = roomRoutingRequest(input);
    const result = await decider.choose("roomRouting", state, question, {
      timeoutMs: options.timeoutMs ?? ROOM_ROUTING_TIMEOUT_MS,
      signal: options.signal,
    });
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    const { choice, pTop } = result.answers;
    if (pTop < ROOM_ROUTING_MIN_PROBABILITY) return { kind: "fallback", reason: "low_confidence" };
    if (choice === EVERYONE_OPTION) return { kind: "everyone", probability: pTop };
    if (!input.members.some((member) => member.id === choice)) return { kind: "fallback", reason: "malformed" };
    return { kind: "member", botId: choice, probability: pTop };
  } catch {
    return { kind: "fallback", reason: "malformed" };
  }
}
