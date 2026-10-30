import { describe, expect, it } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import { botPreview, groupPreview, lastPreviewable } from "./sidebar-preview";

let at = 0;
const message = (fields: Partial<Message>): Message => ({ id: `m${++at}`, at, role: "bot", kind: "text", ...fields }) as Message;
const screen = () => message({ kind: "screen", png: "frame", mime: "image/jpeg" });
const bot = { id: "ada", name: "Ada", messages: [], busy: false } as unknown as Bot;

describe("sidebar previews", () => {
  it("shows a bot's reply, not the screen frame its computer turn ended with", () => {
    const visible = [message({ role: "user", text: "Paint a sunset" }), message({ text: "I painted a sunset in JS Paint." }), screen()];
    expect(botPreview(bot, visible, [], false)).toBe("I painted a sunset in JS Paint.");
    expect(botPreview(bot, [...visible, message({ kind: "digest", text: "[digest]" }), screen()], [], false)).toBe("I painted a sunset in JS Paint.");
  });

  it("shows nothing for a conversation that holds only screen frames", () => {
    expect(botPreview(bot, [screen(), screen()], [], false)).toBe("");
    expect(lastPreviewable([screen(), message({ kind: "compaction" })])).toBeUndefined();
  });

  const step = (name: string) => message({ kind: "activity", tool: { name, ok: true } } as Partial<Message>);

  it("quotes the bot in Simple mode when its newest line is a step that went fine, and keeps the step in Advanced", () => {
    const visible = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "Archived 31 newsletters." }), step("Bash")];
    expect(botPreview(bot, visible, [], false)).toBe("Archived 31 newsletters.");
    expect(botPreview(bot, visible, [], true)).toBe("Bash");
    expect(botPreview(bot, [message({ role: "user", text: "Tidy my inbox" }), step("Bash")], [], false)).not.toBe("Tidy my inbox");
    expect(botPreview(bot, [message({ text: "Earlier reply" }), message({ role: "user", text: "Tidy my inbox" }), step("Bash")], [], false)).not.toBe("Earlier reply");
  });

  it("keeps a failed step's error line and a recovery or notice line as they are", () => {
    const failed = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "On it." }), message({ kind: "activity", tool: { name: "error: Gmail is not connected", ok: false } } as Partial<Message>)];
    expect(botPreview(bot, failed, [], false)).toContain("Gmail is not connected");
    const notice = [message({ role: "user", text: "Tidy my inbox" }), message({ text: "On it." }), step("notice: Switched to a backup model")];
    expect(botPreview(bot, notice, [], false)).toBe("Switched to a backup model");
  });

  it("says a helper's intro card by its first line in the reader's language instead of its stored English title", () => {
    const intro = message({ kind: "options", helperIntro: true, card: { title: "Hi! I'm Ada, your Chief of Staff.", options: [] } } as unknown as Partial<Message>);
    expect(botPreview({ ...bot, chiefOfStaff: true } as Bot, [intro], [], false)).toBe("Hey! I'm Ada. I'm new here.");
    expect(botPreview(bot, [intro], [], false)).toBe("Hi! I'm Ada, your helper for everything here.");
    expect(botPreview({ ...bot, chiefOfStaff: true } as Bot, [intro], [], true), "Advanced mode's one-bubble intro").toBe("Hi, I'm Ada, your helper for everything here.");
  });

  it("quotes the bot in a Simple group chat too", () => {
    const from = { botId: "ada", name: "Ada", color: "green" } as Message["from"];
    const group = { id: "g", name: "Room", messages: [message({ role: "user", text: "Plan the launch" }), message({ text: "Here is the plan.", from }), message({ kind: "activity", tool: { name: "Read", ok: true }, from } as Partial<Message>)] } as unknown as Group;
    expect(groupPreview(group, [bot], [], false)).toBe("Ada: Here is the plan.");
    expect(groupPreview(group, [bot], [], true)).toBe("Ada: Read");
  });

  it("skips screen frames in a group chat's preview too", () => {
    const group = { id: "g", name: "Room", messages: [message({ text: "Done.", from: { botId: "ada", name: "Ada", color: "green" } }), screen()] } as unknown as Group;
    expect(groupPreview(group, [bot], [], false)).toBe("Ada: Done.");
  });
});
