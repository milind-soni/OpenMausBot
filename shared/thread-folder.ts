/** A conversation's own folder, `<data>/task-workspaces/<bot>/<thread>`: where a thread of a bot without a working folder
 * runs, and the one folder a thread leaves for its bot's working folder once the bot has one. */
export function isOwnThreadFolder(path: string | null | undefined, botId: string, threadId: string): boolean {
  const parts = (path ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.at(-3) === "task-workspaces" && parts.at(-2) === botId && parts.at(-1) === threadId;
}
