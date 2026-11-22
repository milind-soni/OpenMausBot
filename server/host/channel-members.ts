type MemberBot = { hidden?: boolean };

/** A room's member list from a request: known bot ids, deduplicated, with at least one active bot. An address of another
 * place that no record here answers to is left out, not refused. */
export function checkedMemberIds(value: unknown, bot: (id: string) => MemberBot | null | undefined): { ok: true; memberIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "memberIds must be a list of bot IDs" };
  const invalidIndex = value.findIndex((id) => typeof id !== "string" || !id.trim() || (!bot(id) && !id.startsWith("link-")));
  if (invalidIndex !== -1) return { ok: false, error: `unknown channel member: ${String(value[invalidIndex])}` };
  const memberIds = [...new Set(value as string[])].filter((id) => bot(id));
  if (!memberIds.length) return { ok: false, error: "a channel needs at least one bot" };
  if (memberIds.every((id) => bot(id)?.hidden)) return { ok: false, error: "a channel needs at least one active bot — every member given is archived" };
  return { ok: true, memberIds };
}
