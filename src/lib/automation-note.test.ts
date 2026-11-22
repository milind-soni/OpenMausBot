import { afterEach, describe, expect, it } from "vitest";
import { bubbleGroup } from "@/components/chat-bubble";
import { lastLine } from "@/components/sidebar-preview";
import type { Bot, Message } from "@/state/store";
import { continueNote, retryNote, startPrompt } from "../../server/routine-recovery";
import { composeExecutionPrompt } from "../../server/routine-execution";
import { createWaitHost } from "../../server/wait-host";
import { automationNote, automationNoteTitle } from "./automation-note";
import { setLocale } from "./i18n";
import { unreadContextMessage } from "./unread-context";
import { firstUnreadMessageId } from "./unread-divider";

afterEach(() => setLocale("en"));

/** The line a wait's follow-up run starts its turn with, built by the server's own code. */
function followUpLine(label: string, followUp: string, retried?: "restarted" | "stalled", said = false): string {
  let queued = "";
  const host = createWaitHost({
    store: {} as never, directChat: () => true, threadBusy: () => false, wrote: () => {}, notify: () => {}, cloudHome: false,
    enqueue: (input) => { queued = input.prompt ?? ""; return { id: "run" }; },
  });
  host.followUp!({ id: "wait-1", botId: "bot", threadId: "thread", label, followUp } as never);
  const first = composeExecutionPrompt({ id: "wait:wait-1", name: label, trigger: "webhook", runOn: "maus" }, queued, undefined);
  return startPrompt({ retried }, queued, first, () => said);
}

const line = (text: string, extra: Partial<Message> = {}): Message => ({ id: "m", role: "user", kind: "text", at: 1, text, ...extra }) as Message;

describe("automationNote", () => {
  it("reads a wait's follow-up as the app's line, not the person's", () => {
    const text = followUpLine("the report", "Read /tmp/report.txt\nand say what changed.");
    expect(text).toBe("[Wait finished: the report] Read /tmp/report.txt\nand say what changed.");
    expect(automationNote(line(text))).toEqual({ wait: "the report", instructions: "Read /tmp/report.txt\nand say what changed." });
  });

  it("keeps the app's second-start line out of the instructions and names what cut the first start off", () => {
    expect(automationNote(line(followUpLine("the build", "Ship it.", "restarted")))).toEqual({ wait: "the build", instructions: "Ship it.", resumed: "restart" });
    expect(automationNote(line(followUpLine("the build", "Ship it.", "stalled")))).toEqual({ wait: "the build", instructions: "Ship it.", resumed: "interrupted" });
  });

  it("reads a second start that only carries the app's line", () => {
    const text = followUpLine("the build", "Ship it.", "restarted", true);
    expect(text).toBe(continueNote("restarted"));
    expect(automationNote(line(text))).toEqual({ instructions: "", resumed: "restart" });
  });

  it("leaves what a person or a bot wrote alone", () => {
    expect(automationNote(line("Tell me when the report is ready"))).toBeNull();
    expect(automationNote(line(`I saw this:\n\n${retryNote("restarted")}`))).toBeNull();
    expect(automationNote(line("[Wait finished: x] y", { role: "bot" }))).toBeNull();
  });

  it("is no bubble of the person's, no line they wrote, and previews in the app's words", () => {
    const wait = line(followUpLine("the report", "Say it is ready."), { id: "wait" });
    const asked = line("Tell me when the report is ready", { id: "asked" });
    const answer = { id: "answer", role: "bot", kind: "text", at: 3, text: "It is ready." } as Message;
    expect(bubbleGroup(asked, "bot")).toBe("user");
    expect(bubbleGroup(wait, "bot")).toBeNull();
    expect(firstUnreadMessageId([asked, wait, answer])).toBe("wait");
    expect(unreadContextMessage([asked, wait, answer], "answer")?.id).toBe("asked");
    expect(lastLine({} as Bot, [asked, wait], [], false)).toBe("Wait over: the report");
    setLocale("pt-br");
    expect(automationNoteTitle(automationNote(wait)!)).toBe("Espera concluída: the report");
    expect(automationNoteTitle(automationNote(line(continueNote("restarted")))!)).toBe("Retomada depois que o OpenMausBot reiniciou");
  });
});
