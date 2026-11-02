import { describe, expect, it } from "vitest";

import { quietRow } from "@/components/chat-bubble";
import { roomActivityVisible } from "./room-activity";
import type { Message } from "@/state/store";

const chip = (partial: Partial<Message>): Message => ({
  id: "m",
  role: "bot",
  kind: "activity",
  at: 1,
  tool: { name: "Read a file", ok: true },
  ...partial,
});

describe("roomActivityVisible", () => {
  it("hides an ordinary finished step unless tool calls are on", () => {
    expect(roomActivityVisible(chip({}), false)).toBe(false);
    expect(roomActivityVisible(chip({}), true)).toBe(true);
  });

  it("always shows a stopped turn, a model notice and a recovery row", () => {
    expect(roomActivityVisible(chip({ tool: { name: "stopped: Stopped", ok: true } }), false)).toBe(true);
    expect(roomActivityVisible(chip({ tool: { name: "notice: OpenCode no longer offers a, so this conversation uses b.", ok: true } }), false)).toBe(true);
    expect(roomActivityVisible(chip({ tool: { name: "recovery: Automatic recovery: trying a backup once.", ok: true } }), false)).toBe(true);
  });

  it("hides a failed step like a 1:1 chat, and always shows a failed turn", () => {
    const failedStep = chip({ tool: { name: "Ran a command", ok: false } });
    expect(roomActivityVisible(failedStep, false)).toBe(false);
    expect(roomActivityVisible(failedStep, true)).toBe(true);
    expect(roomActivityVisible(chip({ tool: { name: "error: engine missing" } }), false)).toBe(true);
  });

  it("shows the same activity a 1:1 chat shows when tool calls are off", () => {
    const rows = [
      chip({}),
      chip({ tool: { name: "Ran a command", ok: false } }),
      chip({ tool: { name: "error: engine missing" } }),
      chip({ tool: { name: "stopped: Stopped", ok: true } }),
      chip({ tool: { name: "Messaged @Ada" }, comm: { groupId: "g1", withBotId: "ada", withName: "Ada", withColor: "teal" } }),
    ];
    for (const row of rows) expect(roomActivityVisible(row, false), row.tool?.name).toBe(!quietRow(row, false));
  });

  it("always shows an opened-thread chip, the only trace a bot started a thread", () => {
    const opened = chip({
      tool: { name: "Opened thread #QA PR 245 on Scout", ok: true },
      threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" },
    });
    expect(roomActivityVisible(opened, false)).toBe(true);
  });

  it("always shows a bot-to-bot comm chip", () => {
    const comm = chip({
      tool: { name: "Messaged @Ada" },
      comm: { groupId: "g1", withBotId: "ada", withName: "Ada", withColor: "teal" },
    });
    expect(roomActivityVisible(comm, false)).toBe(true);
  });

  it("is not for text or cards", () => {
    expect(roomActivityVisible(chip({ kind: "text", text: "hi", tool: undefined }), true)).toBe(false);
  });
});
