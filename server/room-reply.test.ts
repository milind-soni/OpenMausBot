import { describe, expect, it } from "vitest";

import type { WireMessage as Message } from "../shared/wire.ts";
import { isPassText, roomTurnNarrationIds, roomTurnReply } from "./room-reply.ts";

const text = (id: string, turnId: string | undefined, extra: Partial<Message> = {}): Message => ({
  id,
  at: 0,
  role: "bot",
  kind: "text",
  text: id,
  ...(turnId ? { turnId } : {}),
  ...extra,
}) as Message;

describe("room replies", () => {
  it("is the turn's final message, not its working notes", () => {
    expect(roomTurnReply(["I'll check my own work history…", "Good, correct layer id…", "Done: the title is fixed."]))
      .toBe("Done: the title is fixed.");
  });

  it("is nothing when the turn said nothing or passed", () => {
    expect(roomTurnReply([])).toBe("");
    expect(roomTurnReply(["  "])).toBe("");
    expect(roomTurnReply(["Working on it", "(pass)"])).toBe("");
    for (const pass of ["pass", "(pass)", "Pass.", " ( pass ) "]) expect(isPassText(pass)).toBe(true);
    expect(isPassText("passing the build now")).toBe(false);
  });

  it("finds the working notes of settled turns only", () => {
    const messages = [
      { id: "u", at: 0, role: "user", kind: "text", text: "go" } as Message,
      text("n1", "t1"),
      text("n2", "t1"),
      text("final", "t1", { turnTerminal: true }),
      text("live1", "t2"),
      text("live2", "t2"),
      text("audio", "t3", { attachments: [{ kind: "audio", path: "/a.m4a", mime: "audio/mp4" }] } as Partial<Message>),
      text("t3final", "t3", { turnTerminal: true }),
      text("legacy", undefined),
    ];
    expect([...roomTurnNarrationIds(messages)]).toEqual(["n1", "n2"]);
  });
});
