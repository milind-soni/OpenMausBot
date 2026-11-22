import { describe, expect, it } from "vitest";

import { renderAvatarSvg } from "../packages/phone-protocol/src/open-bot-avatar/index.ts";
import { FURS } from "../packages/phone-protocol/src/open-bot-avatar/fur.ts";
import { MASCOT_FURS } from "./bot-avatar.ts";
import { engineBody } from "./object-bodies.ts";

const mug = engineBody("obj-mug")!;

describe("avatar fur", () => {
  it("offers the same styles the bot field accepts", () => {
    expect([...FURS]).toEqual([...MASCOT_FURS]);
  });

  it.each(FURS)("draws the body through the %s filter and the face on top of it", (fur) => {
    const svg = renderAvatarSvg(mug, { fur, reducedMotion: true });
    expect(svg).toContain(`<filter id="oba-fur-${fur}"`);
    const group = svg.match(new RegExp(`<g filter="url\\(#oba-fur-${fur}\\)">(.*?)</g>`))![1];
    expect(group).toMatch(/^(<use [^>]*\/>)+$/);
    expect(svg.slice(svg.indexOf(group) + group.length)).toContain("<rect");
  });

  it("leaves a bare or unknown fur unfiltered", () => {
    for (const fur of [undefined, "mohair"]) expect(renderAvatarSvg(mug, { fur: fur as never, reducedMotion: true })).not.toContain("filter");
  });
});
