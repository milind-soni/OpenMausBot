// A reply's runtime events as every client receives them: a finished reply's text as its saved message holds it (the
// goal envelope out, credentials and held secrets masked), so the streamed bubble is swapped for the same words; and a
// room reply's words naming the member who speaks them. Streamed words themselves go out as the engine writes them.
import type { RuntimeEvent } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { visibleCoordinatorText } from "../group-goal-run.ts";

/** A finished reply as its saved message holds it. */
export function savedReplyText(text: string): string {
  return redactSecretsInText(text.includes("openmaus-goal>") ? visibleCoordinatorText(text) : text);
}

export function publicReplyEvent(event: RuntimeEvent, speakerId?: string): RuntimeEvent {
  if (event.type === "item.completed" && event.itemType === "assistant_text") return { ...event, text: savedReplyText(event.text) };
  if (event.type === "content.delta" && event.streamKind === "assistant_text" && speakerId) return { ...event, botId: speakerId };
  return event;
}
