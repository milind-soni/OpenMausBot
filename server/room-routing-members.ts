import type { GroupDefaultResponder } from "./store.ts";

export function roomTurnMembers<Member extends { id: string; hidden?: boolean; home?: { gone?: unknown } }>(
  members: readonly Member[],
  heldInRoom: (member: Member) => boolean,
  botHeld: (member: Member) => boolean,
) {
  const availableMembers = members.filter((member) => !member.hidden);
  const present = availableMembers.filter((member) => !heldInRoom(member));
  // A member that lives in another of the person's places (`home`) answers in the room; it does not lead a team run here.
  const goalMembers = present.filter((member) => !member.home);
  // One that cannot be reached now (its link is off, or its place no longer has it) stays a member and is picked by nobody but the person naming it.
  const routableMembers = present.filter((member) => !botHeld(member) && !member.home?.gone);
  return { availableMembers, goalMembers, routableMembers };
}

export function autoRoomDefault(
  responder: GroupDefaultResponder,
  routableMembers: readonly { id: string }[],
  replyBot?: { id: string },
): GroupDefaultResponder {
  if (responder.kind !== "auto") return responder;
  const lead = replyBot ?? routableMembers.find((member) => member.id === responder.fallbackBotId) ?? routableMembers[0];
  return lead ? { kind: "member", botId: lead.id } : responder;
}
