import { describe, expect, it } from "vitest";

import { chooseScreenshots, renderReplayHtml, type ReplayModel, type ReplayStep } from "./replay.ts";

const step = (n: number, extra: Partial<ReplayStep> = {}): ReplayStep => ({ n, at: n * 1000, kind: "browser", action: `Step ${n}`, ok: true, image: { step: n, bytes: 100 }, ...extra });

describe("a replay's screenshots", () => {
  it("keeps them all when they fit", () => {
    expect([...chooseScreenshots([step(1), step(2), step(3)])].sort()).toEqual([1, 2, 3]);
  });

  it("keeps failures, then the first and last, then new pages, then the rest spread out", () => {
    const steps = Array.from({ length: 9 }, (_, i) => step(i + 1, i === 5 ? { ok: false } : i === 3 ? { navigated: true } : {}));
    expect([...chooseScreenshots(steps, 100 * 4)]).toEqual([6, 1, 9, 4]);
    // One more fits the middle of what's left.
    expect([...chooseScreenshots(steps, 100 * 5)]).toContain(5);
    expect(chooseScreenshots(steps, 10_000, 2).size).toBe(2);
    // A step without a picture is never counted.
    expect([...chooseScreenshots([step(1, { image: undefined }), step(2)])]).toEqual([2]);
  });
});

describe("the replay page", () => {
  const model: ReplayModel = {
    title: "Find a <b>flight</b>", bot: "Scout", request: "Find me a flight </div><script>alert(1)</script>", answer: "Booked.\nSee you",
    startedAt: Date.UTC(2026, 10, 8, 9), endedAt: Date.UTC(2026, 10, 8, 9, 3),
    steps: [step(1, { site: "example.test/flights", detail: "\"Flights\" <img src=x onerror=alert(1)>" }), step(2, { kind: "tool", action: "Read notes.md", image: undefined, ok: false })],
  };

  it("escapes every text it shows and runs nothing of the bot's", () => {
    const html = renderReplayHtml(model, (one) => (one.image ? `img/step-${one.n}.jpg` : null));
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<title>Find a &lt;b&gt;flight&lt;/b&gt;</title>");
    expect(html).toContain('src="img/step-1.jpg"');
    expect(html).toContain("Scout · 2026-11-08 · 3 min · 2 steps");
    expect(html).toContain("Booked.<br>See you");
    expect(html).toContain('class="step failed"');
    expect(html).toContain('id="play"');
  });

  it("has no player when no step has a picture", () => {
    const html = renderReplayHtml(model, () => null);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });
});
