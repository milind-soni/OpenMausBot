// What a bot is told when it uses the apps and screen of a computer lent to this server. The desktop relays cua-driver's
// answers unchanged and older desktops send raw failures, so the plain fix is added here, on the server.
import { textOnlyErrorResult } from "./mcp-error-result.ts";
import { CLICK_TOOLS, unconfirmedClickResult } from "./unconfirmed-click.ts";

type Part = { type?: unknown; text?: unknown };
type ToolResult = { content?: Part[]; isError?: boolean };

export const LENT_SCREEN_BROWSING =
  "To browse on this lent screen: launch_app with urls opens the page in the person's own browser, signed in as they are; read it with get_window_state (include_screenshot when the tree is thin) and act with click, type_text and press_key. get_browser_state and the browser_* tools work only when that browser already has a DevTools endpoint, which most do not.";

/** The person may be using the computer while a bot does: background actions run, foreground ones wait for them to step away. */
export const LENT_SCREEN_BACKGROUND =
  "The person may be using this computer while you work. Act in the background so you never take their mouse or keyboard: give the app's pid and window_id (from launch_app or list_windows) and act on elements from get_window_state. A call with delivery_mode \"foreground\", scope \"desktop\", drag, bring_to_front or no window waits until they have stepped away.";

export const LENT_BROWSER_NO_ENDPOINT =
  "This computer's browser has no DevTools endpoint, and setting one up is not part of a lent screen, so get_browser_state and the browser_* tools cannot drive it: do not retry them. Use the screen instead: launch_app with urls opens the page in the person's own browser; read it with get_window_state and act with click, type_text and press_key.";

/** cua-driver 0.12.6 and 0.28.2 name a browser that needs browser_prepare with these codes. */
const NEEDS_SETUP = /\bbrowser_(?:requires_setup|route_unavailable)\b/u;

const RAW_FAILURES: ReadonlyArray<[RegExp, string]> = [
  [/\bspawn\b.*\bcua-driver(?:\.exe)?\b.*\b(?:ENOENT|EPERM|EACCES|EBUSY|UNKNOWN)\b|\bcua-driver binary not found\b/iu,
    "Computer control could not start on this computer: its helper, cua-driver, is missing or blocked. Tell the person in one sentence: Windows Security may have quarantined it, so on that PC open Windows Security → Virus & threat protection → Protection history, restore or allow cua-driver.exe (or reinstall OpenMausBot), then restart OpenMausBot. Do not retry until they say it is fixed."],
  [/^Computer-control transport closed$/u,
    "Computer control stopped on this computer: its helper, cua-driver, exited. Try the action once more; if it fails the same way, tell the person that Windows Security may have quarantined cua-driver.exe (restore it from Protection history, or reinstall OpenMausBot) and to restart OpenMausBot."],
  [/^Computer control is unavailable\. Enable it in the local app and grant OS permissions first\.$/u,
    "Computer control is not running on this computer. Tell the person in one sentence to open OpenMausBot on it: on Windows, restore cua-driver.exe if Windows Security quarantined it (Protection history) or reinstall; on a Mac, allow Accessibility and Screen Recording for OpenMausBot. Then try again."],
  // Older desktops say this for any failed screen check, though it is rarely a person.
  [/^This computer is in use locally or held by a person\. Wait, then observe it again before acting\.$/u,
    "This computer did not let this call use its screen, so it was not performed. Another bot on it may be using the screen, or OpenMausBot on it could not check; it is not necessarily a person. Try again in a minute; if it keeps saying this, tell the person to update OpenMausBot on that computer, or quit and reopen it."],
  [/^fetch failed$/u,
    "OpenMausBot on this computer is not answering its own screen-control check. Tell the person to restart OpenMausBot on that computer, then try again."],
];

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n").trim();
}

const withPart = (result: ToolResult, text: string): ToolResult => ({ ...result, content: [...(result.content ?? []), { type: "text", text }] });

export function lentScreenResult(operation: { action: string; tool_name?: string }, value: unknown): unknown {
  if (operation.action !== "computer_tools" && operation.action !== "computer_call") return value;
  if (!value || typeof value !== "object" || !Array.isArray((value as ToolResult).content)) return value;
  const result = textOnlyErrorResult(value as ToolResult);
  if (operation.action === "computer_tools") return result.isError ? result : withPart(withPart(result, LENT_SCREEN_BROWSING), LENT_SCREEN_BACKGROUND);
  const sent = CLICK_TOOLS.has(operation.tool_name ?? "") ? unconfirmedClickResult(result) : null;
  if (sent) return sent;
  if (result.isError) {
    const text = textOf(result);
    const fix = RAW_FAILURES.find(([pattern]) => pattern.test(text));
    if (fix) return { ...result, content: [{ type: "text", text: fix[1] }] };
  }
  const browser = operation.tool_name === "browser_prepare" || operation.tool_name === "get_browser_state" || operation.tool_name?.startsWith("browser_");
  if (browser && (NEEDS_SETUP.test(JSON.stringify(result)) || (result.isError && operation.tool_name === "browser_prepare"))) {
    return withPart(result, LENT_BROWSER_NO_ENDPOINT);
  }
  return result;
}
