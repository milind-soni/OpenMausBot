/** Keep the whole bot row selectable while its inline name editor is open.
 * The input owns its clicks; every other part of the row still opens the bot. */
export function botListItemPointerIntent(
  type: string,
  insideRenameInput = false,
): "select" | "ignore" {
  return type === "click" && !insideRenameInput ? "select" : "ignore";
}
