import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the pinned message out of the strip above both transcripts", () => {
  for (const file of ["chat-v2/ChatV2.tsx", "GroupView.tsx"]) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(text, file).not.toContain("chat.pinnedJump");
  }
  expect(readFileSync(new URL("./RoomHeader.tsx", import.meta.url), "utf8")).toContain("<PinnedMessagesMenu");
});
