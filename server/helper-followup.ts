// POST /api/bots/:id/helper-followup (routes/bot-messages.ts): MausBot's follow-up after its first look around, written
// once under its intro as a real bot message. Its client says what it saw (an AI, the apps); the counts are the server's.
import { z } from "zod";

import { defaultBotPerson } from "../shared/default-bot.ts";
import { englishFollowup, type HelperFollowupFacts } from "../shared/helper-followup.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { BotRecord, Message } from "./store.ts";

const appName = z.string().transform((name) => name.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1).max(60));

export const helperFollowupBody = z.object({
  threadId: z.string().regex(/^[\w-]+$/).optional(),
  ai: z.enum(["own", "backup", "none"]),
  apps: z.array(appName).max(20).default([]),
});

/** Only MausBot's own person writes its follow-up: on a Team Cloud the member it belongs to, else the place's owner. */
export function mayFollowUp(bot: BotRecord, auth: RequestAuth): boolean {
  const person = defaultBotPerson(bot);
  if (!person) return auth.scopes.includes("admin");
  return auth.kind === "session" && auth.session.email?.trim().toLowerCase() === person;
}

function seenBy(bot: BotRecord, person: string): boolean {
  const visibility = bot.visibility;
  if (!person || visibility === undefined || visibility === "everyone") return true;
  return typeof visibility === "object" && visibility.people.some((email) => email.trim().toLowerCase() === person);
}

/** What MausBot found: what its client saw, with the person's other bots and the routines they run counted here. */
export function followupFacts(
  maus: BotRecord,
  seen: { ai: HelperFollowupFacts["ai"]; apps: readonly string[] },
  bots: readonly BotRecord[],
  routines: readonly { botId: string; enabled: boolean }[],
): HelperFollowupFacts {
  const person = defaultBotPerson(maus);
  const others = bots.filter((bot) => bot.id !== maus.id && !bot.hidden && !bot.defaultBot && !bot.movedTo && seenBy(bot, person));
  const theirs = new Set([maus.id, ...others.map((bot) => bot.id)]);
  return {
    ai: seen.ai,
    apps: [...new Set(seen.apps)],
    bots: others.length,
    routines: routines.filter((routine) => routine.enabled && theirs.has(routine.botId)).length,
  };
}

/** The follow-up to append to `transcript`, or the one already there: a conversation gets one, under MausBot's intro. */
export function helperFollowup(transcript: readonly Message[], facts: () => HelperFollowupFacts):
  { existing: Message } | { append: Omit<Message, "id" | "at"> } | null {
  if (!transcript.some((message) => message.helperIntro)) return null;
  const existing = transcript.find((message) => message.helperFollowup);
  if (existing) return { existing };
  const found = facts();
  return { append: { role: "bot", kind: "text", text: englishFollowup(found), helperFollowup: found } };
}
