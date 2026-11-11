// What the room router reads (decider/room-routing.ts): the room, its people and bots, and its recent lines, built here
// from the room so nothing secret or an attachment's markup leaves this machine.
import type { ResolvedSender } from "../../shared/wire.ts";
import type { RoomRoutingInput } from "../decider/room-routing.ts";
import { redactSecretsInText } from "../redact.ts";
import { speakerOf, type PersonName } from "../replies.ts";
import type { BotRecord, Message } from "../store.ts";
import { extractTurnImages } from "../turn-images.ts";

/** Scrubbed of secrets and attachment markup before it leaves this machine. */
export function roomRoutingInput(
  roomName: string,
  text: string,
  members: readonly BotRecord[],
  history: readonly Message[],
  userName: PersonName,
  sender?: ResolvedSender,
): RoomRoutingInput {
  const clean = (value: string) => redactSecretsInText(extractTurnImages(value).text);
  const humans = new Set<string>(typeof userName === "string" ? [userName] : []);
  const recent = history.flatMap((m) => {
    if (m.kind !== "text" || !m.text) return [];
    if (m.role === "user") {
      const person = speakerOf(userName, m);
      humans.add(person);
      return [{ from: person, text: clean(m.text) }];
    }
    return [{ from: `${m.from?.name ?? "A bot"} (bot)`, text: clean(m.text) }];
  });
  const from = speakerOf(userName, { sender });
  humans.add(from);
  return {
    room: roomName,
    humans: [...humans],
    members: members.map((member) => ({ id: member.id, name: member.name, title: member.title, description: member.description })),
    recent,
    message: { from, text: clean(text) },
  };
}
