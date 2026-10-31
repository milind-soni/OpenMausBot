/**
 * The design follows Hermes Agent's desktop group chat (MIT), ported to this
 * room model rather than copied.
 */
import { isMentionBoundary, isMentionNameContinuation } from "../shared/mention-boundary.ts";
import type { RoomHold, RoomHeldMessage } from "../shared/wire.ts";
import { isServerLine, serverLine } from "./server-lines.ts";

const STOP_WINDOW = 2;
const STOP_WORDS = new Set(["stop", "halt", "pause"]);
const OBJECT_STARTERS = new Set(["this", "that", "these", "those", "the", "a", "an", "my", "our", "your", "his", "her", "their", "its"]);
const OWN_WORK_OR_URGENCY = new Set(["now", "please", "right", "immediately", "asap", "work", "task", "job", "turn", "run", "reply"]);
const STOP_COMMANDS = new Set(["stop", "halt", "cancel", "abort"]);
const STOP_FILLERS = new Set(["now", "please", "right", "immediately", "asap", "it", "that", "this", "everything", "all"]);
export const MAX_HELD_MESSAGES = 20;

export type HoldDirective = {
  hold: string[];
  holdAll: boolean;
  release: string[];
  releaseAll: boolean;
};

export function maskQuotedAndCode(value: string): string {
  const mentionsOnly = (span: string): string => (span.match(/@[\p{L}\p{N}._-]+/gu) ?? []).join(" ") || "quoted";
  const kept: string[] = [];
  let fence = "";
  for (const line of value.split("\n")) {
    if (fence) {
      const closing = line.trim().startsWith(fence);
      kept.push(closing ? "" : mentionsOnly(line));
      if (closing) fence = "";
      continue;
    }
    const opened = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opened) {
      fence = opened[1]!;
      continue;
    }
    if (/^\s*>/.test(line)) {
      kept.push(mentionsOnly(line));
      continue;
    }
    // Typographic quotes too: smart-quote substitution rewrites straight ones.
    kept.push(line.replace(/`[^`\n]*`/g, mentionsOnly).replace(/["“”][^"“”\n]*["“”]/g, mentionsOnly));
  }
  return kept.join("\n");
}

export function stopWordPlacement(text: string): "adjacent" | "distant" | null {
  const tokens = maskQuotedAndCode(text).toLowerCase().match(/@[\p{L}\p{N}._-]+|[\p{L}\p{N}_-]+/gu) ?? [];
  const mentions: number[] = [];
  const stops: number[] = [];
  const takesObject = (index: number) => {
    const next = tokens[index + 1];
    const after = tokens[index + 2];
    return next !== undefined && OBJECT_STARTERS.has(next) && after !== undefined && !after.startsWith("@") && !OWN_WORK_OR_URGENCY.has(after);
  };
  tokens.forEach((token, index) => {
    if (token.startsWith("@")) mentions.push(index);
    else if (STOP_WORDS.has(token) && !takesObject(index)) stops.push(index);
  });
  if (stops.some((stop) => mentions.some((mention) => Math.abs(stop - mention) <= STOP_WINDOW))) return "adjacent";
  return stops.length ? "distant" : null;
}

export function addressesEveryone(text: string): boolean {
  const surface = maskQuotedAndCode(text);
  for (const word of ["everyone", "all"]) {
    for (let at = surface.indexOf("@"); at !== -1; at = surface.indexOf("@", at + 1)) {
      const candidate = surface.slice(at + 1, at + 1 + word.length);
      if (
        isMentionBoundary(surface, at) &&
        candidate.toLocaleLowerCase() === word &&
        !isMentionNameContinuation(surface.slice(at + 1 + word.length))
      ) return true;
    }
  }
  return false;
}

function isBareResume(text: string): boolean {
  const words = maskQuotedAndCode(text).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.length > 0 && words[0] === "resume" && words.slice(1).every((word) => ["all", "everyone", "please"].includes(word));
}

export function isStopCommand(text: string): boolean {
  const words = maskQuotedAndCode(text).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.some((word) => STOP_COMMANDS.has(word)) && words.every((word) => STOP_COMMANDS.has(word) || STOP_FILLERS.has(word));
}

/** A stop word far from every mention changes nothing: re-dispatching a bot the person just stopped is the one mistake to avoid. */
export function classifyHoldDirective(text: string, mentioned: readonly string[]): HoldDirective {
  const everyone = addressesEveryone(text);
  const stop = stopWordPlacement(text);
  if (stop === "adjacent") return { hold: [...mentioned], holdAll: everyone, release: [], releaseAll: false };
  return {
    hold: [],
    holdAll: false,
    release: stop === "distant" ? [] : [...mentioned],
    releaseAll: stop === null && (everyone || isBareResume(text)),
  };
}

export type HoldChange = {
  holds: Record<string, RoomHold>;
  held: string[];
  released: string[];
};

export function applyHoldDirective(
  holds: Record<string, RoomHold> | undefined,
  directive: HoldDirective,
  memberIds: readonly string[],
  at: number,
): HoldChange {
  const prior = holds ?? {};
  if (directive.releaseAll) {
    const released = Object.keys(prior);
    return { holds: released.length ? {} : prior, held: [], released };
  }
  let next = prior;
  const held: string[] = [];
  const released: string[] = [];
  const toHold = directive.holdAll ? memberIds : directive.hold.filter((id) => memberIds.includes(id));
  for (const id of toHold) {
    if (next[id]) continue;
    if (next === prior) next = { ...prior };
    next[id] = { at };
    held.push(id);
  }
  for (const id of directive.release) {
    if (!next[id]) continue;
    if (next === prior) next = { ...prior };
    delete next[id];
    released.push(id);
  }
  return { holds: next, held, released };
}

export function rememberHeldMessage(
  heldMessages: Record<string, RoomHeldMessage[]> | undefined,
  botId: string,
  entry: RoomHeldMessage,
): Record<string, RoomHeldMessage[]> {
  const current = heldMessages?.[botId] ?? [];
  if (current.some((item) => item.messageId === entry.messageId)) return heldMessages ?? {};
  return { ...heldMessages, [botId]: [...current, entry].slice(-MAX_HELD_MESSAGES) };
}

/** The room's status row for a held member, in the room's language; a coordinator reads it in English. */
export function heldMemberLine(name: string, language?: string): string {
  return serverLine(language, "server.rooms.held", { bot: name });
}

export function isHeldMemberLine(text: string): boolean {
  return isServerLine("server.rooms.held", text);
}
