import { afterEach, describe, expect, it } from "vitest";
import { bubbleGroup } from "@/components/chat-bubble";
import { lastLine } from "@/components/sidebar-preview";
import type { Bot, Message } from "@/state/store";
import { continueNote, retryNote, startPrompt } from "../../server/routine-recovery";
import { composeExecutionPrompt } from "../../server/routine-execution";
import { createWaitHost } from "../../server/wait-host";
import { automationNote, automationNoteTitle, knownWaits, lastRequests } from "./automation-note";
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

const typed = (text: string, extra: Partial<Message> = {}): Message => ({ id: "m", role: "user", kind: "text", at: 1, text, ...extra }) as Message;
/** As the server stores a line an automation started a turn with. */
const line = (text: string, extra: Partial<Message> = {}): Message => typed(text, { automated: true, ...extra });
const waitCard = (label: string, followUp: string): Message => ({ id: `card-${label}`, role: "bot", kind: "options", at: 1, card: { title: "", options: [], waitRequest: { waitId: label, label, followUp } } }) as unknown as Message;

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

  it("leaves what a person or a bot wrote alone, even in the app's own words", () => {
    expect(automationNote(typed("Tell me when the report is ready"))).toBeNull();
    expect(automationNote(line(`I saw this:\n\n${retryNote("restarted")}`))).toBeNull();
    expect(automationNote(line("[Wait finished: x] y", { role: "bot" }))).toBeNull();
    const pasted = typed("[Wait finished: teste] minhas palavras", { id: "pasted" });
    expect(automationNote(pasted)).toBeNull();
    expect(automationNote(pasted, [{ label: "teste", followUp: "minhas palavras" }])).toBeNull();
    expect(automationNote(typed(continueNote("restarted")))).toBeNull();
    expect(automationNote(typed(followUpLine("the build", "Ship it.", "restarted")))).toBeNull();
    expect(bubbleGroup(pasted, "bot")).toBe("user");
    expect(firstUnreadMessageId([pasted, { id: "answer", role: "bot", kind: "text", at: 2, text: "ok" } as Message])).toBe("answer");
    expect(lastLine({} as Bot, [pasted], [], false)).toBe("[Wait finished: teste] minhas palavras");
    expect(lastRequests([pasted]).typed).toBe(pasted);
  });

  it("takes a label that holds \"] \" whole from the wait's own card", () => {
    const text = followUpLine("release [QA] aprovada", "Publish [the] notes.");
    const card = waitCard("release [QA] aprovada", "Publish [the] notes.");
    expect(automationNote(line(text), knownWaits([card]))).toEqual({ wait: "release [QA] aprovada", instructions: "Publish [the] notes." });
    expect(automationNote(line(text), knownWaits([waitCard("release [QA", "Something else."), card]))?.wait).toBe("release [QA] aprovada");
    expect(lastLine({} as Bot, [card, line(text)], [], false)).toBe("Following up on the wait: release [QA] aprovada");
    expect(automationNote(line(text))?.wait).toBe("release [QA");
  });

  it("picks the wait whose card matches the whole line, not the longest name that starts it", () => {
    const build = waitCard("build", "prod] Check logs and notify."), prod = waitCard("build] prod", "Check logs");
    const waits = knownWaits([build, prod]);
    expect(automationNote(line(followUpLine("build", "prod] Check logs and notify.")), waits)).toEqual({ wait: "build", instructions: "prod] Check logs and notify." });
    expect(automationNote(line(followUpLine("build] prod", "Check logs")), waits)).toEqual({ wait: "build] prod", instructions: "Check logs" });
    expect(automationNote(line(followUpLine("build", "prod] Check logs and notify.", "restarted")), waits)).toMatchObject({ wait: "build", instructions: "prod] Check logs and notify.", resumed: "restart" });
  });

  it("sends again the line a reply answers, and offers for editing only what the person typed", () => {
    const asked = typed("Tell me when the report is ready", { id: "asked" });
    const wait = line(followUpLine("the report", "Say it is ready."), { id: "wait" });
    const reply = { id: "reply", role: "bot", kind: "text", at: 3, text: "It is ready." } as Message;
    expect(lastRequests([asked, reply])).toEqual({ answered: asked, typed: asked });
    expect(lastRequests([asked, reply, wait, reply])).toEqual({ answered: wait, typed: asked });
    const later = typed("Thanks", { id: "later" }), liked = typed("👍", { id: "liked", reaction: "👍" } as Partial<Message>);
    expect(lastRequests([asked, wait, reply, later, liked])).toEqual({ answered: liked, typed: later });
    expect(lastRequests([reply])).toEqual({ answered: undefined, typed: undefined });
  });

  it("is no bubble of the person's, no line they wrote, and previews in the app's words", () => {
    const wait = line(followUpLine("the report", "Say it is ready."), { id: "wait" });
    const asked = line("Tell me when the report is ready", { id: "asked" });
    const answer = { id: "answer", role: "bot", kind: "text", at: 3, text: "It is ready." } as Message;
    expect(bubbleGroup(asked, "bot")).toBe("user");
    expect(bubbleGroup(wait, "bot")).toBeNull();
    expect(firstUnreadMessageId([asked, wait, answer])).toBe("wait");
    expect(unreadContextMessage([asked, wait, answer], "answer")?.id).toBe("asked");
    expect(lastLine({} as Bot, [asked, wait], [], false)).toBe("Following up on the wait: the report");
    setLocale("pt-br");
    expect(automationNoteTitle(automationNote(wait)!)).toBe("Continuação da espera: the report");
    expect(automationNoteTitle(automationNote(line(continueNote("restarted")))!)).toBe("Retomada depois que o OpenMausBot reiniciou");
  });
});
