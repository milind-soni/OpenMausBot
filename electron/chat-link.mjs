// openmausbot://thread/<thread-id>?bot=<bot-id>, openmausbot://bot/<bot-id> and a saved app's openmausbot://app/<id>. The
// page checks them strictly against its chats; opening one never sends, interrupts or creates anything. A launcher's app
// link (`?window=1`) is not the page's: it opens the app's own window (app-launches.mjs).
import { parseAppLink } from "./app-link.mjs";

const CHAT_LINK_PREFIXES = ["openmausbot://thread/", "openmausbot://bot/"];
const MAX_LINK_LENGTH = 1024;

export function chatLinkFrom(value) {
  const link = typeof value === "string" ? value.trim() : "";
  if (link.length > MAX_LINK_LENGTH) return null;
  const lower = link.toLowerCase();
  if (CHAT_LINK_PREFIXES.some((prefix) => lower.startsWith(prefix))) return link;
  const app = parseAppLink(link);
  return app && !app.window ? link : null;
}

export function chatLinkFromCommandLine(argv) {
  for (const value of argv) {
    const link = chatLinkFrom(value);
    if (link) return link;
  }
  return null;
}
