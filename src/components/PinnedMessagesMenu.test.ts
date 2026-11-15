import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the pinned message out of the strip above both transcripts", () => {
  for (const file of ["ChatView.tsx", "GroupView.tsx"]) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(text, file).not.toContain("chat.pinnedJump");
  }
  expect(readFileSync(new URL("./RoomHeader.tsx", import.meta.url), "utf8")).toContain("<PinnedMessagesMenu");
  expect(readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")).toMatch(/<PinnedMessagesMenu[\s\S]{0,600}data-tour="computer"/);
});
