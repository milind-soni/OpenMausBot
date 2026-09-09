import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import { goalCoordinatorForComposer, groupComposerHint, roomRespondersForComposer } from "./group-routing";
import type { GroupDefaultResponder } from "@/state/store";

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

describe("composer hint, in the reader's language", () => {
  afterEach(() => {
    setLocale("en");
  });

  it("translates every routing case and keeps the lead's own name", () => {
    const members = [
      { id: "first", name: "Juniper" },
      { id: "lead", name: "Atlas" },
    ] as Parameters<typeof groupComposerHint>[1];
    const room = (defaultResponder: GroupDefaultResponder) =>
      ({ defaultResponder, dm: false }) as Parameters<typeof groupComposerHint>[0];

    setLocale("pt-br");
    expect(groupComposerHint(room({ kind: "everyone" }), members)).toBe("todos respondem");
    expect(groupComposerHint(room({ kind: "mentions" }), members)).toBe("@ para chamar um bot");
    // Select the non-first member so fallback routing cannot satisfy the assertion.
    expect(groupComposerHint(room({ kind: "member", botId: "lead" }), members)).toBe("Atlas responde");
    expect(groupComposerHint({ dm: true } as Parameters<typeof groupComposerHint>[0], members)).toBe(
      "continuar a conversa",
    );

    setLocale("ja");
    expect(groupComposerHint(room({ kind: "everyone" }), members)).toBe("全員が応答します");
  });
});
