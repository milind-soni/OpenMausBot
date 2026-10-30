import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { duplicateBotProfile, restrictedCopyRequest } from "./bot-duplicate";

describe("what a duplicated bot is created with", () => {
  it("asks for nothing when the source is not restricted", () => {
    expect(restrictedCopyRequest({})).toEqual({});
    // "everyone" is the default audience, and allowed is the default for the helper model
    expect(restrictedCopyRequest({ visibility: "everyone", helperModel: true })).toEqual({});
  });

  it("carries who may see the bot", () => {
    expect(restrictedCopyRequest({ visibility: "admins" })).toEqual({ visibility: "admins" });
    expect(restrictedCopyRequest({ visibility: { people: ["ada@example.test"] } })).toEqual({ visibility: { people: ["ada@example.test"] } });
  });

  it("carries the tool selection whenever the source has one, an empty one included", () => {
    const scope = { allow: ["native:read"], deny: ["native:bash"] };
    expect(restrictedCopyRequest({ toolScope: scope })).toEqual({ settings: { toolScope: scope } });
    expect(restrictedCopyRequest({ toolScope: { allow: [] } })).toEqual({ settings: { toolScope: { allow: [] } } });
  });

  it("keeps a copy off the helper model when its source is kept off it", () => {
    expect(restrictedCopyRequest({ helperModel: false })).toEqual({ settings: { helperModel: false } });
    // a value only a hand-edited bots.json could hold reads as never, as it does on the server
    for (const odd of ["false", 0, null]) {
      expect(restrictedCopyRequest({ helperModel: odd as unknown as boolean }), JSON.stringify(odd)).toEqual({ settings: { helperModel: false } });
    }
  });

  it("carries every restriction together, in the one request that creates the copy", () => {
    const source = { visibility: "admins" as const, toolScope: { allow: [] }, helperModel: false };
    expect(restrictedCopyRequest(source)).toEqual({ visibility: "admins", settings: { toolScope: { allow: [] }, helperModel: false } });
    // what the request body looks like on the wire
    expect(JSON.parse(JSON.stringify(restrictedCopyRequest(source)))).toEqual({ visibility: "admins", settings: { toolScope: { allow: [] }, helperModel: false } });
  });

  it("keeps a copy of a VPS bot on its source's own server, and on the default when the source has none", () => {
    const source = {
      id: "src", threadId: "t", name: "Rio", title: "", description: "", notifications: true, color: "green", unread: false,
      modelSelection: { instanceId: "codex", model: "default" }, messages: [],
      computer: "cloud", cloudBackend: "vps", autoStartVps: true, vpsAlias: "alpha-vps",
    } as Bot;
    expect(duplicateBotProfile(source)).toMatchObject({ name: "Rio copy", computer: "cloud", cloudBackend: "vps", autoStartVps: true, vpsAlias: "alpha-vps" });
    const { vpsAlias: _alias, ...onDefault } = source;
    expect(duplicateBotProfile(onDefault as Bot).vpsAlias).toBeUndefined();
  });
});
