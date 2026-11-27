import { describe, expect, it } from "vitest";

import { renderAvatarSvg } from "../packages/phone-protocol/src/open-bot-avatar/render.ts";
import { OBJECT_BODIES } from "./object-bodies.ts";

describe("avatar svg", () => {
  it("names the avatar with aria-label only, so no <title> tooltip hides the row's", () => {
    const svg = renderAvatarSvg(OBJECT_BODIES["obj-mug"]);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Mug"');
    expect(svg).not.toContain("<title>");
  });
});
