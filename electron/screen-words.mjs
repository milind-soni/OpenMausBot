// What the menu-bar or taskbar icon and this app's own prompt say when this computer's apps and screen can't be lent to
// the person's own Clouds, from computer control's state.

/** Why apps and screen aren't available, as one plain sentence without a full stop; null when they are. */
export function screenLine(status, device) {
  if (!status || status.ready) return null;
  switch (status.reason) {
    case "starting": return `Screen control is starting on this ${device}`;
    case "permissions": return "macOS hasn't allowed screen control yet";
    case "blocked": return device === "PC"
      ? "Screen control is blocked: Windows Security may have stopped it"
      : `Screen control is blocked on this ${device}`;
    case "off": return `Screen control is off on this ${device}`;
    case "unsupported": return status.message ? status.message.replace(/\.$/, "") : `Screen control can't work on this ${device}`;
    default: return `Screen control isn't running on this ${device}`;
  }
}

/** The one action that fixes it, as a menu item or button; null when nothing here can. */
export function screenFixLabel(status) {
  if (!status || status.ready || !status.fix) return null;
  if (status.fix === "allow") return "Allow screen control…";
  return status.reason === "off" ? "Turn on screen control" : "Start screen control";
}

const WANTS = {
  screen: device => `use this ${device}'s apps and screen`,
  folders: device => `use the files on this ${device}`,
  terminal: device => `run commands on this ${device}`,
};

/** Why a bot's ask can't be met here now, from the reason its Cloud gives. */
function askReason(reason, device) {
  if (reason === "paused") return `Using this ${device} is paused.`;
  if (reason === "terminal-off") return `Running commands isn't turned on for this ${device}.`;
  if (reason === "permissions") return "macOS hasn't allowed OpenMausBot to see and use the screen yet. Turn on asks macOS.";
  return `${screenLine({ ready: false, reason }, device)}.`;
}

/** The prompt this app shows by itself for one ask: who wants what, their words, why it can't now, and the fix. */
export function askPromptWords(ask, { cloud, device }) {
  const want = (WANTS[ask.need] ?? WANTS.screen)(device);
  const why = typeof ask.why === "string" && ask.why.trim() ? `“${ask.why.trim()}”\n\n` : "";
  return {
    message: `${ask.bot} on ${cloud} wants to ${want}`,
    detail: `${why}${askReason(ask.reason, device)}`,
    buttons: ["Turn on", "Not now"],
  };
}

/** A reason Turn on can fix on this computer. */
export const fixableHere = reason => ["paused", "permissions", "blocked", "off", "not-running", "terminal-off"].includes(reason);
