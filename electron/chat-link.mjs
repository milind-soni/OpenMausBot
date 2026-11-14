// openmausbot://thread/<thread-id>?bot=<bot-id> and openmausbot://bot/<bot-id>. The page checks them strictly against
// its chats; opening one never sends, interrupts or creates anything.
const CHAT_LINK_PREFIXES = ["openmausbot://thread/", "openmausbot://bot/"];
const MAX_LINK_LENGTH = 1024;

export function chatLinkFrom(value) {
  const link = typeof value === "string" ? value.trim() : "";
  if (link.length > MAX_LINK_LENGTH) return null;
  const lower = link.toLowerCase();
  return CHAT_LINK_PREFIXES.some((prefix) => lower.startsWith(prefix)) ? link : null;
}

export function chatLinkFromCommandLine(argv) {
  for (const value of argv) {
    const link = chatLinkFrom(value);
    if (link) return link;
  }
  return null;
}
