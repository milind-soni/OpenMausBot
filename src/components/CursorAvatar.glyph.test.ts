import { describe, expect, it } from "vitest";
import { EFFECTS } from "./CursorAvatar";
import { stateForBot } from "@/lib/mascot";

describe("the mascot's symbols", () => {
  it("shows an unread reply with a speech bubble, never the exclamation mark of a real alert", () => {
    const alert = EFFECTS.alerting?.glyph?.markup;
    const unread = EFFECTS.notifying?.glyph?.markup;
    expect(alert).toBeTruthy();
    expect(unread).toBeTruthy();
    expect(unread).not.toBe(alert);
    expect(unread).toContain('stroke-linejoin="round"');
    expect(stateForBot({ name: "Chief", messages: [], unread: true })).toBe("notifying");
    expect(stateForBot({ name: "Chief", messages: [{ kind: "activity", tool: { ok: false } }] })).toBe("alerting");
  });
});
