import { expect, it } from "vitest";

import { autoRoomDefault, roomTurnMembers } from "./room-routing-members.ts";

const ids = (members: ReadonlyArray<{ id: string }>) => members.map((member) => member.id);

it("a member from another place answers in the room but leads no team run; one that cannot be reached is picked by nobody but the person naming it", () => {
  const members = [
    { id: "writer" },
    { id: "archived", hidden: true },
    { id: "held" },
    { id: "paused" },
    { id: "link-0000abcd-atlas", home: {} },
    { id: "link-0000abcd-nova", home: { gone: "off" } },
    { id: "link-0000abcd-scout", home: { gone: "missing" } },
  ];
  const { availableMembers, goalMembers, routableMembers } = roomTurnMembers(members, (member) => member.id === "held", (member) => member.id === "paused");
  // Named by the person, each is still found: the room then says why one that is out of reach does not answer.
  expect(ids(availableMembers)).toEqual(["writer", "held", "paused", "link-0000abcd-atlas", "link-0000abcd-nova", "link-0000abcd-scout"]);
  expect(ids(goalMembers)).toEqual(["writer", "paused"]);
  expect(ids(routableMembers)).toEqual(["writer", "link-0000abcd-atlas"]);
  // The room's own choice of who answers never falls on one that is out of reach.
  expect(autoRoomDefault({ kind: "auto", fallbackBotId: "link-0000abcd-nova" } as never, routableMembers)).toEqual({ kind: "member", botId: "writer" });
});
