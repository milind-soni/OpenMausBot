import { describe, expect, it } from "vitest";

import { roomAddressees } from "./room-addressees";
import type { Message } from "@/state/store";

const mylo = { id: "b-mylo", name: "Mylo", color: "purple" as const };
const athena = { id: "b-athena", name: "Athena", color: "green" as const };
const members = [mylo, athena];
const from = (bot: typeof mylo | typeof athena) => ({ botId: bot.id, name: bot.name, color: bot.color });
const msg = (over: Partial<Message>): Message => ({ id: "m", role: "bot", kind: "text", text: "", at: 1, ...over } as Message);

describe("roomAddressees", () => {
  it("names the room bots a message @mentions, not the sender", () => {
    const message = msg({ from: from(mylo), text: "Sure. @Athena, can you draw it? cc @Mylo" });
    expect(roomAddressees(message, members, [])).toEqual([{ key: athena.id, name: "Athena", color: "green" }]);
  });

  it("names the author of the replied-to message first", () => {
    const asked = msg({ id: "q", from: from(mylo), text: "@Athena chart please" });
    const reply = msg({ id: "r", from: from(athena), replyToId: "q", text: "On it. @Mylo" });
    expect(roomAddressees(reply, members, [asked, reply])).toEqual([{ key: mylo.id, name: "Mylo", color: "purple" }]);
  });

  it("calls the person You when a bot replies to them", () => {
    const asked = msg({ id: "q", role: "user", text: "@Mylo check sales" });
    const reply = msg({ id: "r", from: from(mylo), replyToId: "q", text: "Done." });
    expect(roomAddressees(reply, members, [asked, reply])).toEqual([{ key: "user:You", name: "You" }]);
  });

  it("leaves a tag a same-named teammate takes to the teammate", () => {
    const message = msg({ from: from(mylo), text: "@Athena can you check? @Athena Bot too" });
    const bots = [...members, { id: "b-athena-bot", name: "Athena Bot", color: "blue" as const }];
    expect(roomAddressees(message, bots, [], [{ name: "Athena", person: true }]))
      .toEqual([{ key: "b-athena-bot", name: "Athena Bot", color: "blue" }]);
  });

  it("ignores mentions inside code and plain text without mentions", () => {
    expect(roomAddressees(msg({ from: from(mylo), text: "run `@Athena` later" }), members, [])).toEqual([]);
    expect(roomAddressees(msg({ from: from(mylo), text: "Sales were up 12%." }), members, [])).toEqual([]);
  });
});
