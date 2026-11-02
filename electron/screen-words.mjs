// What the menu-bar or taskbar icon and this app's own prompt say when this computer's apps and screen can't be lent to
// the person's own Clouds, from computer control's state.
import { desktopText } from "./i18n.mjs";

/** Why apps and screen aren't available, as one plain sentence without a full stop; null when they are. */
export function screenLine(status, device) {
  if (!status || status.ready) return null;
  switch (status.reason) {
    case "starting": return desktopText("desktop.extra.screen.starting", { device });
    case "permissions": return desktopText("desktop.extra.screen.permissions");
    case "blocked": return device === "PC"
      ? desktopText("desktop.extra.screen.blockedWindows")
      : desktopText("desktop.extra.screen.blocked", { device });
    case "off": return desktopText("desktop.extra.screen.off", { device });
    case "unsupported": return status.message ? status.message.replace(/\.$/, "") : desktopText("desktop.extra.screen.unsupported", { device });
    default: return desktopText("desktop.extra.screen.notRunning", { device });
  }
}

/** The one action that fixes it, as a menu item or button; null when nothing here can. */
export function screenFixLabel(status) {
  if (!status || status.ready || !status.fix) return null;
  if (status.fix === "allow") return desktopText("desktop.extra.screen.allow");
  return desktopText(status.reason === "off" ? "desktop.extra.screen.turnOn" : "desktop.extra.screen.start");
}

const WANTS = {
  screen: device => desktopText("desktop.extra.ask.needScreen", { device }),
  folders: device => desktopText("desktop.extra.ask.needFolders", { device }),
  terminal: device => desktopText("desktop.extra.ask.needTerminal", { device }),
};

/** Why a bot's ask can't be met here now, from the reason its Cloud gives. */
function askReason(reason, device) {
  if (reason === "paused") return desktopText("desktop.extra.ask.paused", { device });
  if (reason === "terminal-off") return desktopText("desktop.extra.ask.terminalOff", { device });
  if (reason === "permissions") return desktopText("desktop.extra.ask.permissions");
  return desktopText("desktop.extra.ask.reason", { reason: screenLine({ ready: false, reason }, device) });
}

/** The prompt this app shows by itself for one ask: who wants what, their words, why it can't now, and the fix. */
export function askPromptWords(ask, { cloud, device }) {
  const want = (WANTS[ask.need] ?? WANTS.screen)(device);
  const why = typeof ask.why === "string" && ask.why.trim() ? `“${ask.why.trim()}”\n\n` : "";
  return {
    message: desktopText("desktop.extra.ask.message", { bot: ask.bot, cloud, want }),
    detail: `${why}${askReason(ask.reason, device)}`,
    buttons: [desktopText("desktop.extra.ask.turnOn"), desktopText("desktop.common.notNow")],
  };
}

/** A reason Turn on can fix on this computer. */
export const fixableHere = reason => ["paused", "permissions", "blocked", "off", "not-running", "terminal-off"].includes(reason);
