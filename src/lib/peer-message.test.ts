import { describe, expect, it } from "vitest";

import { peerExchange, peerLine, peerPreview, peerRequest } from "./peer-message";

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

describe("peerLine: the one note", () => {
  it("reads the author and what it is off the note, and strips it", () => {
    const text = "[From @Chief (bot) · message · information only — not from your user. @Chief is waiting on your answer, so reply to them.]\n\nWhich database?";
    expect(peerLine({ role: "user", text })).toEqual({ name: "Chief", delivery: "ask_bot", body: "Which database?" });
    const handed = "[From @Lead (bot) · assignment · on their behalf at your level — for the user's request \"ship it\". This is your task.]\n\nShip it.";
    expect(peerLine({ role: "user", text: handed })).toEqual({ name: "Lead", delivery: "delegate_bot", body: "Ship it." });
  });

  it("does not read a note a person wrote into their own line", () => {
    expect(peerLine({ role: "user", text: "(From @Chief (bot) · message · information only] hi" })).toBeNull();
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

describe("peerPreview", () => {
  it("leaves a short one-line request as it is", () => {
    expect(peerPreview("Which database?")).toBeNull();
  });

  it("folds a long or many-line request to one line", () => {
    const long = "Please check the build. ".repeat(8);
    expect(peerPreview(long)).toBe(long.trim());
    expect(peerPreview("Step one\nStep two\nStep three\nStep four")).toBe("Step one Step two Step three Step four");
  });

  it("cuts a very long request short", () => {
    const preview = peerPreview("word ".repeat(200))!;
    expect(preview.length).toBeLessThanOrEqual(241);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("peerExchange", () => {
  const ask = (id: string, name: string, botId: string, body: string, at: number) =>
    ({ id, role: "user" as const, kind: "text" as const, text: body, at, peerAsk: { botId, name } });
  const reply = (id: string, text: string, at: number) => ({ id, role: "bot" as const, kind: "text" as const, text, at });

  it("keeps one peer's requests and this bot's text answers to them, in order", () => {
    const messages = [
      { id: "u1", role: "user" as const, kind: "text" as const, text: "my own line", at: 1 },
      reply("b1", "answer to the person", 2),
      ask("p1", "Liaison", "L", "First request", 3),
      { id: "t1", role: "bot" as const, kind: "activity" as const, text: "", at: 4 },
      reply("b2", "Done with the first", 5),
      ask("p2", "Other", "O", "Not this peer", 6),
      reply("b3", "answer to Other", 7),
      ask("p3", "Liaison", "L", "Second request", 8),
      reply("b4", "Done with the second", 9),
      { id: "u2", role: "user" as const, kind: "text" as const, text: "person again", at: 10 },
      reply("b5", "answer to the person again", 11),
    ];
    expect(peerExchange(messages, "me", { botId: "L", name: "Liaison" })).toEqual([
      { id: "p1", from: "peer", text: "First request", at: 3 },
      { id: "b2", from: "bot", text: "Done with the first", at: 5 },
      { id: "p3", from: "peer", text: "Second request", at: 8 },
      { id: "b4", from: "bot", text: "Done with the second", at: 9 },
    ]);
  });

  it("files a reply under the request it names, even after another line", () => {
    const messages = [
      ask("p1", "Liaison", "L", "First request", 1),
      { id: "u1", role: "user" as const, kind: "text" as const, text: "person in between", at: 2 },
      { ...reply("b1", "Done with the first", 3), requestMessageId: "p1" },
      ask("p2", "Other", "O", "Not this peer", 4),
      { ...reply("b2", "late answer to Liaison", 5), requestMessageId: "p1" },
      { ...reply("b3", "answer to Other", 6), requestMessageId: "p2" },
    ];
    expect(peerExchange(messages, "me", { botId: "L", name: "Liaison" }).map((line) => line.id)).toEqual(["p1", "b1", "b2"]);
    expect(peerExchange(messages, "me", { botId: "O", name: "Other" }).map((line) => line.id)).toEqual(["p2", "b3"]);
  });

  it("leaves out another room member's reply", () => {
    const messages = [
      ask("p1", "Liaison", "L", "First request", 1),
      { ...reply("m1", "member's own reply", 2), from: { botId: "M", name: "Member", color: "blue" as const } },
      { ...reply("b1", "my answer", 3), from: { botId: "me", name: "Helper", color: "green" as const } },
    ];
    expect(peerExchange(messages, "me", { botId: "L", name: "Liaison" }).map((line) => line.id)).toEqual(["p1", "b1"]);
  });

  it("matches room requests from the same peer by name when no id is known", () => {
    const messages = [
      { id: "r1", role: "bot" as const, kind: "text" as const, text: "Room ask", at: 1, from: { name: "Chief" }, roomRequest: { phase: "request" } },
      reply("b1", "Room answer", 2),
    ];
    expect(peerExchange(messages as never, "me", { name: "Chief" })).toEqual([
      { id: "r1", from: "peer", text: "Room ask", at: 1 },
      { id: "b1", from: "bot", text: "Room answer", at: 2 },
    ]);
  });
});
