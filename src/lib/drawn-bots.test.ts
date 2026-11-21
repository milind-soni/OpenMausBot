import { describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { sameDrawnBots } from "./drawn-bots";

const bot = (fields: Partial<Bot> = {}): Bot => ({
  id: "bot", threadId: "thread", name: "Fixture", title: "Writer", description: "", notifications: true,
  unread: false, color: "green", messages: [], ...fields,
} as Bot);

describe("sameDrawnBots", () => {
  it("keeps the list when only what readers do not draw changed", () => {
    expect(sameDrawnBots([bot()], [bot({ unread: true, messages: [{ id: "m" } as Bot["messages"][number]] })])).toBe(true);
  });

  it("draws again when the name or look changed", () => {
    expect(sameDrawnBots([bot()], [bot({ name: "Renamed" })])).toBe(false);
    expect(sameDrawnBots([bot()], [bot({ color: "blue" })])).toBe(false);
  });

  it("draws again when the title or chief-of-staff mark changed, which the @-mention menu shows", () => {
    expect(sameDrawnBots([bot()], [bot({ title: "Editor" })])).toBe(false);
    expect(sameDrawnBots([bot({ title: "" })], [bot({ title: "", chiefOfStaff: true })])).toBe(false);
  });

  it("draws again when a bot was added or removed", () => {
    expect(sameDrawnBots([bot()], [bot(), bot({ id: "other" })])).toBe(false);
  });
});
