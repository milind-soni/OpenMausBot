export function unreadConversationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean }>,
  groups: Array<{ unread?: boolean }>,
): number {
  return bots.filter((bot) => !bot.hidden && bot.unread).length + groups.filter((group) => group.unread).length;
}

export function openNotificationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean; activity?: string }>,
  groups: Array<{ unread?: boolean }>,
): number {
  const agentNotifications = bots.filter(
    (bot) => !bot.hidden && (bot.unread || bot.activity === "waiting-on-you"),
  ).length;
  return agentNotifications + groups.filter((group) => group.unread).length;
}
