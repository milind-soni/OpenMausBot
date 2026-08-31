import { describe, expect, it } from "vitest";

import { goalCoordinatorForComposer, roomRespondersForComposer } from "./group-routing";

describe("roomRespondersForComposer", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(
      roomRespondersForComposer("hello there", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(
      roomRespondersForComposer("@Milind take this", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "everyone" } })).toEqual(members);
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "mentions" } })).toEqual([]);
    expect(roomRespondersForComposer("@everyone hello", members, { defaultResponder: { kind: "mentions" } })).toEqual(
      members,
    );
  });
});

describe("goalCoordinatorForComposer", () => {
  const members = [
    { id: "first", name: "First" },
    { id: "chief", name: "Chief", chiefOfStaff: true },
    { id: "writer", name: "Writer" },
  ];

  it("uses an explicit mention before the configured lead", () => {
    expect(goalCoordinatorForComposer(
      "@Writer finish this",
      members,
      { defaultResponder: { kind: "member", botId: "first" } },
    )?.id).toBe("writer");
  });

  it("falls back to the in-room Chief for mentions-only goal channels", () => {
    expect(goalCoordinatorForComposer(
      "finish this",
      members,
      { defaultResponder: { kind: "mentions" } },
    )?.id).toBe("chief");
  });
});
