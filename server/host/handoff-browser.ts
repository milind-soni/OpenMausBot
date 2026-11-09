// A teammate's hand-off may move only to the built-in browser with select_computer, never to another computer: no person
// watches a hand-off's Screen panel, and fill_login needs the bot's own browser. The turn that continues there owns the result.
export const HANDOFF_BROWSER_ONLY = "A teammate's hand-off can move only to the built-in browser: call select_computer with surface browser, or carry on with the computer already in use.";

export const HANDOFF_BROWSER_NOTE = " This is a teammate's hand-off: when it needs the built-in browser (for example to sign in with a saved login), call select_computer with surface browser and end this turn; the hand-off continues there and its result still returns. It cannot move to any other computer.";

/** The place a hand-off's select_computer asks for: auto means the built-in browser; any other computer is refused. */
export function handoffSurface(asked: unknown): "browser" | null {
  return asked === "auto" || asked === "browser" ? "browser" : null;
}
