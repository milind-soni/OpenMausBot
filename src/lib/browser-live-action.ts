// What the v1 live view posts for each kind of input: the frozen action shapes, with no reach into the rest of the app.
import type { PreviewStreamInput } from "./browser-stream-client";

export type LiveActionBody = Record<string, unknown>;

const CHAR_LIMIT = 4_096;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : 0));
export const delta = (value: number) => clamp(value, -10_000, 10_000);

/** A v2 message as the v1 action it stands for; null for what v1 has no action for. */
export function liveAction(input: PreviewStreamInput): LiveActionBody | LiveActionBody[] | null {
  switch (input.type) {
    case "mouse":
      return {
        type: "input_mouse", eventType: input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : "mouseMoved",
        x: clamp(input.x, 0, 8192), y: clamp(input.y, 0, 8192), button: input.button,
        clickCount: Math.round(clamp(input.clickCount, 0, 3)), modifiers: input.modifiers,
      };
    case "wheel":
      return { type: "input_mouse", eventType: "mouseWheel", x: clamp(input.x, 0, 8192), y: clamp(input.y, 0, 8192), button: "none", deltaX: delta(input.deltaX), deltaY: delta(input.deltaY), modifiers: input.modifiers };
    case "key":
      if (!input.key) return null;
      return {
        type: "input_keyboard", eventType: input.action === "up" ? "keyUp" : "keyDown", key: input.key.slice(0, 64), code: input.code.slice(0, 64),
        windowsVirtualKeyCode: Math.round(clamp(input.keyCode ?? 0, 0, 255)), modifiers: input.modifiers,
        ...(input.text !== undefined ? { text: input.text } : {}),
      };
    case "text": {
      const chunks: LiveActionBody[] = [];
      for (let at = 0; at < input.text.length; at += CHAR_LIMIT) chunks.push({ type: "input_keyboard", eventType: "char", text: input.text.slice(at, at + CHAR_LIMIT) });
      return chunks;
    }
    case "navigate": return { type: "navigate", url: input.url };
    case "history": return { type: input.delta < 0 ? "back" : "forward" };
    case "reload": return { type: "reload" };
    case "tabSelect": return { type: "tab-select", tabId: input.tabId };
    case "tabClose": return { type: "tab-close", tabId: input.tabId };
    case "tabNew": return input.url ? { type: "tab-new", url: input.url } : { type: "tab-new" };
    case "restart": return { type: "restart" };
    case "selectChoose": return { type: "select_choose", id: input.id.slice(0, 64), index: Math.round(clamp(input.index, 0, 499)) };
    case "dialog": return { type: "dialog", accept: input.accept, ...(input.promptText !== undefined ? { promptText: input.promptText.slice(0, 4_096) } : {}) };
    default: return null;
  }
}
