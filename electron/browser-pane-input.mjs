// Telling the bot's own input apart from the person's in a pane. Electron reports every CDP Input.dispatch* as an
// input-event too (measured on Electron 43: within 0-6 ms, before the command answers), so each command the bot sends
// registers the events it will cause, and only those are taken as the bot's: by type, count and, for the mouse,
// position. A registration ends a few milliseconds after its command answers; a wheel's scroll gestures, later.

/** Slack after a command answers, for an event Electron reports late. */
export const ECHO_SLACK_MS = 8;
/**
 * One dispatched wheel is reported as exactly two mouseWheel events and a gestureScrollBegin, Update and End (measured
 * on Electron 43: 50 wheels for 25 dispatched, every one at most 1 ms after the command answered). Electron's wheel
 * events carry no point, so they are matched by count and time: once both of a bot's wheels are seen, the next is the
 * person's. Known residual: a person's wheel within this long after a bot scroll, before the bot's second wheel
 * arrives, counts as the bot's.
 */
export const SCROLL_SLACK_MS = 20;
const SCROLL_GESTURES = ["gestureScrollBegin", "gestureScrollUpdate", "gestureScrollEnd", "gestureFlingStart", "gestureFlingCancel"];
/** How far apart a dispatched point and its reported event may be, in CSS pixels. */
const POSITION_SLACK = 2;

const MOUSE = { mousePressed: "mouseDown", mouseReleased: "mouseUp", mouseMoved: "mouseMove" };
const TOUCH = { touchStart: "touchStart", touchMove: "touchMove", touchEnd: "touchEnd", touchCancel: "touchCancel" };

/** The input-events one CDP input command causes in the page it is sent to. */
export function echoesOf(method, params) {
  const p = params ?? {};
  if (method === "Input.dispatchMouseEvent") {
    if (p.type === "mouseWheel") {
      return [
        { types: ["mouseWheel"], slack: SCROLL_SLACK_MS }, { types: ["mouseWheel"], slack: SCROLL_SLACK_MS },
        { types: ["gestureScrollBegin"], slack: SCROLL_SLACK_MS }, { types: ["gestureScrollEnd"], slack: SCROLL_SLACK_MS },
        { types: ["gestureScrollUpdate", "gestureFlingStart", "gestureFlingCancel"], any: true, slack: SCROLL_SLACK_MS },
      ];
    }
    const type = MOUSE[p.type];
    return type ? [{ types: [type], x: Number(p.x), y: Number(p.y) }] : [];
  }
  if (method === "Input.dispatchKeyEvent") {
    if (p.type === "keyDown") return [{ types: ["keyDown", "rawKeyDown"] }, ...(typeof p.text === "string" && p.text ? [{ types: ["char"] }] : [])];
    if (p.type === "rawKeyDown") return [{ types: ["rawKeyDown"] }];
    if (p.type === "char") return [{ types: ["char"] }];
    if (p.type === "keyUp") return [{ types: ["keyUp"] }];
    return [];
  }
  // Text the bot inserts reaches the page as characters, as many as it holds, or as none (an IME commit).
  if (method === "Input.insertText") return [{ types: ["char"], any: true }];
  // A touch can become a tap or a scroll as the page sees it.
  if (method === "Input.dispatchTouchEvent") return TOUCH[p.type] ? [{ types: [TOUCH[p.type]], any: true }, { types: [...SCROLL_GESTURES, "gestureTapDown", "gestureShowPress", "gestureTap", "gestureTapCancel"], any: true, slack: SCROLL_SLACK_MS }] : [];
  return [];
}

export function createEchoes(now = Date.now) {
  let pending = [];
  return {
    /** The events a command about to be sent will cause; call the returned function when it answers. */
    expect(method, params) {
      const added = echoesOf(method, params).map((echo) => ({ ...echo, until: Infinity }));
      pending.push(...added);
      return () => {
        const at = now();
        for (const echo of added) echo.until = at + (echo.slack ?? ECHO_SLACK_MS);
      };
    },
    /** True when an input-event is one the bot's command caused; it is then used up. */
    take(input) {
      const at = now();
      pending = pending.filter((echo) => echo.until >= at);
      const placed = (echo) => echo.x === undefined || !Number.isFinite(echo.x) || !Number.isFinite(input.x)
        || (Math.abs(echo.x - input.x) <= POSITION_SLACK && Math.abs(echo.y - input.y) <= POSITION_SLACK);
      let index = pending.findIndex((echo) => echo.types.includes(input?.type) && placed(echo));
      // Should Electron report the point in other units, an event of the type while its command still runs is the bot's.
      if (index < 0) index = pending.findIndex((echo) => echo.types.includes(input?.type) && echo.until === Infinity);
      if (index < 0) return false;
      if (!pending[index].any) pending.splice(index, 1);
      return true;
    },
    /** Whether any command of the bot's is still waiting for its answer. */
    get inFlight() {
      return pending.some((echo) => echo.until === Infinity);
    },
  };
}
