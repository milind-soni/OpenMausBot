// cua-driver 0.28.2 (and its main branch in October 2026) checks after a Windows foreground click that the clicked window,
// or a window it owns, is in front (platform-windows/src/input/mouse.rs). A click that picks a menu item closes the menu,
// and one that opens or closes a window moves the front elsewhere, so the check fails after the click was sent, and the
// driver answers foreground_unavailable as if nothing happened: the bot then repeats the click or reports a failure.

type JsonObject = Record<string, unknown>;

/** Only this check runs after the input; every check before it says no input was sent. */
const AFTER_THE_CLICK = /^foreground_unavailable: .* was not foreground after the click\b/u;

export const CLICK_TOOLS: ReadonlySet<string> = new Set(["click", "double_click", "right_click"]);

export const CLICK_SENT_UNCONFIRMED =
  "The click was sent. Afterwards a different window was in front, which is what happens when a click picks a menu item " +
  "(the menu closes) or opens or closes a window, so where it landed is not confirmed. Do not click again until you have " +
  "checked the result with get_window_state.";

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The driver's answer when only its after-click check failed, told as the sent, unconfirmed click it was; otherwise null. */
export function unconfirmedClickResult(result: unknown): JsonObject | null {
  if (!isObject(result) || result.isError !== true || !Array.isArray(result.content)) return null;
  const said = result.content.some((part) => isObject(part) && part.type === "text" && typeof part.text === "string" && AFTER_THE_CLICK.test(part.text));
  if (!said) return null;
  // Its protocol fields (resultType, _meta) stay; what it said does not.
  const envelope = Object.fromEntries(Object.entries(result).filter(([key]) => !["content", "structuredContent", "isError"].includes(key)));
  return {
    ...envelope,
    content: [{ type: "text", text: CLICK_SENT_UNCONFIRMED }],
    // What the driver answers for a foreground click whose check passes: a strict client holds success to this schema.
    structuredContent: { effect: "unverifiable", route: "global_input", delivery: { mode: "foreground" } },
  };
}
