export const SIGNED_IN_AGAIN = "chat.notice.signedInAgain";

/** A signed-out notice (signing in fixes it), or the same row once its AI is signed in again: Retry stays on the turn it
 * follows. */
export function signInNotice(row: { kind: string; tool?: { name: string; setup?: boolean; nameCode?: string } }): boolean {
  return row.kind === "activity" && Boolean(row.tool) && (row.tool!.nameCode === SIGNED_IN_AGAIN || (row.tool!.setup === true && row.tool!.name.startsWith("notice:")));
}
