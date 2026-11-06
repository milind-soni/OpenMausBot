// What the menu-bar or taskbar icon and this app's own prompt say when this computer's apps and screen can't be lent to
// the person's own Clouds, from computer control's state.
import nativeText from "./native-text.cjs";

const namedDevice = (device, t) => device === "computer" ? t("native.lendTray.computer") : device;

/** Why apps and screen aren't available, as one plain sentence without a full stop; null when they are. */
export function screenLine(status, device, t = nativeText.englishText.t) {
  if (!status || status.ready) return null;
  const params = { device: namedDevice(device, t) };
  switch (status.reason) {
    case "starting": return t("native.screen.starting", params);
    case "permissions": return t("native.screen.permissions");
    case "blocked": return device === "PC"
      ? t("native.screen.blockedWindows")
      : t("native.screen.blocked", params);
    case "off": return t("native.screen.off", params);
    case "unsupported": return status.message ? status.message.replace(/\.$/, "") : t("native.screen.unsupported", params);
    default: return t("native.screen.notRunning", params);
  }
}

/** The one action that fixes it, as a menu item or button; null when nothing here can. */
export function screenFixLabel(status, t = nativeText.englishText.t) {
  if (!status || status.ready || !status.fix) return null;
  if (status.fix === "allow") return t("native.screen.allow");
  return t(status.reason === "off" ? "native.screen.turnOn" : "computer.windows.start");
}

const WANTS = {
  screen: "native.screen.wantScreen",
  folders: "native.screen.wantFiles",
  terminal: "native.screen.wantTerminal",
};

/** Why a bot's ask can't be met here now, from the reason its Cloud gives. */
function askReason(reason, device, t) {
  const params = { device: namedDevice(device, t) };
  if (reason === "paused") return t("native.screen.paused", params);
  if (reason === "terminal-off") return t("native.screen.terminalOff", params);
  if (reason === "permissions") return t("native.screen.allowMac");
  return `${screenLine({ ready: false, reason }, device, t)}.`;
}

/** The prompt this app shows by itself for one ask: who wants what, their words, why it can't now, and the fix. */
export function askPromptWords(ask, { cloud, device, t = nativeText.englishText.t }) {
  const want = t(WANTS[ask.need] ?? WANTS.screen, { device: namedDevice(device, t) });
  const why = typeof ask.why === "string" && ask.why.trim() ? `“${ask.why.trim()}”\n\n` : "";
  return {
    message: t("native.screen.askTitle", { bot: ask.bot, cloud, want }),
    detail: `${why}${askReason(ask.reason, device, t)}`,
    buttons: [t("mcp.turnOn"), t("native.dialog.share.notNow")],
  };
}

/** A reason Turn on can fix on this computer. */
export const fixableHere = reason => ["paused", "permissions", "blocked", "off", "not-running", "terminal-off"].includes(reason);
