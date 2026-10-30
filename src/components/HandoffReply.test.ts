import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { HandoffChip } from "./HandoffReply";

const row = (phase: "request" | "result", output?: string): Message => ({
  id: `h1-${phase}`, role: "bot", kind: "activity", at: 1,
  roomRequest: { id: "h1", phase },
  comm: { groupId: "room-1", threadId: "room-1-main", withBotId: "mira", withName: "Mira", withColor: "teal" },
  tool: { name: phase === "result" ? "Mira replied" : "Sent to Mira", ok: true, ...(output === undefined ? {} : { output }) },
});

const render = (message: Message) =>
  renderToStaticMarkup(createElement(HandoffChip, { message, bots: [], title: "Open Mira", onClick: () => {} }));

describe("HandoffChip", () => {
  it("shows the teammate's reply under the chip, with the rest behind a disclosure", () => {
    const markup = render(row("result", "Tests pass on main.\n\nDetails: 412 passed."));
    expect(markup).toContain("Mira replied");
    expect(markup).toContain('data-handoff-reply="h1"');
    expect(markup).toContain("Tests pass on main.");
    expect(markup).toContain("<details");
    expect(markup).toContain("Details: 412 passed.");
  });

  it("shows a one-line reply without a disclosure", () => {
    const markup = render(row("result", "Done."));
    expect(markup).toContain("Done.");
    expect(markup).not.toContain("<details");
  });

  it("keeps the plain chip for the request row and for a reply with no text", () => {
    for (const message of [row("request", "why"), row("result")]) {
      const markup = render(message);
      expect(markup).toContain('title="Open Mira"');
      expect(markup).not.toContain("data-handoff-reply");
    }
  });

  it("puts the hand-off's done-when on one muted line under the sent chip", () => {
    const sent: Message = { ...row("request"), roomRequest: undefined, tool: { name: "Sent to Mira", ok: true }, doneWhen: "the export opens in Numbers" };
    const markup = render(sent);
    expect(markup).toContain("Sent to Mira");
    expect(markup).toContain("data-handoff-done-when");
    expect(markup).toContain("Done when: the export opens in Numbers");
  });

  it("adds no done-when line when the hand-off set none", () => {
    const sent: Message = { ...row("request"), roomRequest: undefined, tool: { name: "Sent to Mira", ok: true } };
    expect(render(sent)).not.toContain("data-handoff-done-when");
  });

  it("marks the chip when the teammate's hand-off failed", () => {
    const failed: Message = { ...row("result"), tool: { name: "Mira — failed: the build broke", ok: false } };
    const markup = render(failed);
    expect(markup).toContain("Mira — failed: the build broke");
    expect(markup).toMatch(/<button[^>]*class="[^"]*text-danger/);
    expect(render(row("result", "Done."))).not.toContain("text-danger");
  });
});
