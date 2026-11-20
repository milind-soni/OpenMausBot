import type { GroupDefaultResponder } from "../shared/wire.ts";

export function roomLeadId(defaultResponder: GroupDefaultResponder): string | undefined {
  if (defaultResponder.kind === "member") return defaultResponder.botId;
  if (defaultResponder.kind === "auto") return defaultResponder.fallbackBotId;
  return undefined;
}

/** Whether a queued room line is meant for the bot speaking now. A line that names bots is for them; an unnamed line
 * is not for a member doing a job another bot handed it, unless that member leads the room. */
export function steerMeantForSpeaker(input: {
  speakerId: string;
  mentioned: readonly string[];
  replyBotId?: string;
  leadId: string | undefined;
  speakerOnHandedWork: boolean;
}): boolean {
  if (input.mentioned.length > 0) return input.mentioned.includes(input.speakerId);
  if (input.replyBotId) return input.speakerId === input.replyBotId;
  return !input.speakerOnHandedWork || input.leadId === input.speakerId;
}
