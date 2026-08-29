import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot, Message } from "@/state/store";
import { CommActivityAvatar } from "./CommActivityAvatar";

const comm: NonNullable<Message["comm"]> = {
  groupId: "capture-chief",
  withBotId: "capture",
  withName: "Capture",
  withColor: "purple",
};

describe("CommActivityAvatar", () => {
  it("renders the current peer bot profile rather than the legacy Maus avatar", () => {
    const bots = [
      {
        id: "capture",
        name: "Capture",
        title: "Signal capture",
        description: "Collects source updates",
        color: "purple",
        avatarCrop: "glyph",
      },
    ] as Bot[];

    const markup = renderToStaticMarkup(
      createElement(CommActivityAvatar, { bots, comm }),
    );

    expect(markup).toContain("agent-glyph-avatar is-capture");
    expect(markup).not.toContain("maus-avatar");
  });

  it("uses a neutral identity fallback if the peer no longer exists", () => {
    const markup = renderToStaticMarkup(
      createElement(CommActivityAvatar, { bots: [], comm }),
    );

    expect(markup).toContain(">C</div>");
    expect(markup).not.toContain("maus-avatar");
  });
});
