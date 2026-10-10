import { describe, expect, it } from "vitest";

import { peerLine, peerRequest } from "./peer-message";

const NOTE = (opening: string, name: string, rest: string) =>
  `[${opening} @${name}, another bot in this OpenMausBot workspace${rest}]`;

describe("peerLine", () => {
  it("is null for the person's own line and for bot lines", () => {
    expect(peerLine({ role: "user", text: "hi" })).toBeNull();
    expect(peerLine({ role: "bot", text: NOTE("Message from", "Chief", " — x") })).toBeNull();
  });

  it("reads the author off the field and strips the note", () => {
    const text = `${NOTE("Message from", "Chief", " — not from your user. @Chief is waiting on your answer, so reply to them.")}\n\nWhich database?`;
    expect(peerLine({ role: "user", text, peerAsk: { botId: "b1", name: "Chief" } })).toEqual({
      botId: "b1",
      name: "Chief",
      delivery: "ask_bot",
      body: "Which database?",
    });
  });

  it("falls back to the note on rows stored before the field existed", () => {
    const text = `${NOTE("Delegated by", "Chief", ". Do the work and reply directly.")}\n\nWrite the summary.\n\n[Reason: followup]`;
    expect(peerLine({ role: "user", text })).toEqual({
      name: "Chief",
      delivery: "delegate_bot",
      body: "Write the summary.\n\n[Reason: followup]",
    });
    expect(peerLine({ role: "user", text: `${NOTE("Thread opened by", "Pam", " — x")}\n\nJob.` })?.delivery).toBe(
      "start_thread",
    );
  });

  it("keeps the field's author when the text has no note, and carries unattended", () => {
    expect(peerLine({ role: "user", text: "plain", peerAsk: { botId: "b1", name: "Scout", unattended: true } })).toEqual({
      botId: "b1",
      name: "Scout",
      delivery: "ask_bot",
      body: "plain",
      unattended: true,
    });
  });
});

describe("peerRequest", () => {
  const from = { botId: "pepper", name: "Pepper", color: "blue" as const };
  const request = { id: "r1", phase: "request" as const };

  it("labels a coordinate_bots request with the bot that sent it", () => {
    expect(peerRequest({ role: "bot", text: "@Engineer Check the export", from, roomRequest: request }, "engineer")).toEqual({
      botId: "pepper",
      name: "Pepper",
      delivery: "coordinate_bots",
      body: "@Engineer Check the export",
    });
  });

  it("is null for results, plain bot lines, user lines and the bot's own row", () => {
    expect(peerRequest({ role: "bot", text: "done", from, roomRequest: { id: "r1", phase: "result" } }, "engineer")).toBeNull();
    expect(peerRequest({ role: "bot", text: "hi", from }, "engineer")).toBeNull();
    expect(peerRequest({ role: "bot", text: "hi", roomRequest: request }, "engineer")).toBeNull();
    expect(peerRequest({ role: "user", text: "hi", from, roomRequest: request }, "engineer")).toBeNull();
    expect(peerRequest({ role: "bot", text: "hi", from, roomRequest: request }, "pepper")).toBeNull();
  });
});
