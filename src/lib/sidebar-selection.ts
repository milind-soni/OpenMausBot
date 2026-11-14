export function botListItemPointerIntent(
  type: string,
  insideRenameInput = false,
): "select" | "ignore" {
  return type === "click" && !insideRenameInput ? "select" : "ignore";
}
