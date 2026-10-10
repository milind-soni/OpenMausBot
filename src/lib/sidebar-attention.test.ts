import { describe, expect, it } from "vitest";

import { sidebarAttentionLabel, sidebarSectionAttention } from "./sidebar-attention";

describe("collapsed sidebar attention", () => {
  it("keeps unread chats and approval waits visible at the section level", () => {
    const attention = sidebarSectionAttention(
      [
        { unread: true, activity: "waiting-on-you" },
        { busy: true, activity: "working" },
      ],
      [{ unread: true }, { busyBotId: "writer" }],
    );

    expect(attention).toEqual({ unread: 2, waiting: 1, working: 2 });
    expect(sidebarAttentionLabel(attention)).toBe(
      "1 waiting for you, 2 unread, 2 working",
    );
  });

  it("does not count a waiting bot twice as working", () => {
    expect(
      sidebarSectionAttention([{ busy: true, activity: "waiting-on-you" }], []),
    ).toEqual({ unread: 0, waiting: 1, working: 0 });
  });
});
