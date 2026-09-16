import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  QueuedComposerMessages,
  composerCanSteerQueuedMessages,
  doubleEnterSteerWindowExpiresAt,
  doubleEnterSteersQueue,
} from "./ComposerQueuedMessages";

const oneItem = [{ queueId: "q1", text: "actually stop at 10\nand use the smaller model" }];

describe("composerCanSteerQueuedMessages", () => {
  it("offers Steer only while this unlocked conversation is live and waiting", () => {
    expect(composerCanSteerQueuedMessages(true, false, 1)).toBe(true);
    expect(composerCanSteerQueuedMessages(true, false, 2)).toBe(true);
    expect(composerCanSteerQueuedMessages(true, false, 0)).toBe(false);
    expect(composerCanSteerQueuedMessages(false, false, 1)).toBe(false);
    expect(composerCanSteerQueuedMessages(true, true, 1)).toBe(false);
    expect(composerCanSteerQueuedMessages(true, false, 1, true)).toBe(false);
  });
});

describe("double-Enter steer gesture", () => {
  it("opens the window only when a chip arrives on a busy steer-capable thread", () => {
    const now = 1_000_000;
    expect(doubleEnterSteerWindowExpiresAt(0, 1, true, true, now)).toBe(now + 1_500);
    // nothing new queued: not a second-Enter moment
    expect(doubleEnterSteerWindowExpiresAt(1, 1, true, true, now)).toBeNull();
    expect(doubleEnterSteerWindowExpiresAt(2, 1, true, true, now)).toBeNull();
    // idle threads and engines without live steering never open it; rooms
    // share the gesture, so capability alone decides
    expect(doubleEnterSteerWindowExpiresAt(0, 1, false, true, now)).toBeNull();
    expect(doubleEnterSteerWindowExpiresAt(0, 1, true, false, now)).toBeNull();
  });

  it("steers on the second Enter only while the composer is empty, a chip waits, and the window is open", () => {
    const now = 1_000_000;
    expect(doubleEnterSteersQueue(now + 1, now, 1, false)).toBe(true);
    expect(doubleEnterSteersQueue(now, now, 1, false)).toBe(false); // window closed
    expect(doubleEnterSteersQueue(now + 1, now, 0, false)).toBe(false); // nothing queued
    expect(doubleEnterSteersQueue(now + 1, now, 1, true)).toBe(false); // typed words: a plain send
  });
});

describe("QueuedComposerMessages", () => {
  it("explains a capacity wait without offering to interrupt another thread", () => {
    const markup = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "capacity", text: "Run when there is room", reason: "capacity" }],
      onCancel: () => undefined,
    }));
    expect(markup).toContain("Queued — starts when this bot has a free thread slot.");
    expect(markup).toContain('aria-label="Delete queued message 1 of 1"');
    expect(markup).not.toContain("Steer");
  });
  it("shows the full queued text in an attached, truncated row with real actions", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, {
        items: oneItem,
        onSteer: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="1 queued message"');
    expect(markup).toContain('aria-label="Queued messages"');
    expect(markup).toContain("actually stop at 10\nand use the smaller model");
    expect(markup).toContain("truncate");
    expect(markup).toContain('aria-label="Steer queued message now"');
    expect(markup).toContain('aria-label="Delete queued message 1 of 1"');
  });

  it("says the fallback Steer stops the running turn when the engine cannot steer live", () => {
    const base = { items: oneItem, onSteer: () => undefined, onCancel: () => undefined } as const;
    const liveMarkup = renderToStaticMarkup(createElement(QueuedComposerMessages, base));
    expect(liveMarkup).toContain("aria-label=\"Steer queued message now\"");
    const interruptMarkup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, { ...base, steerInterrupts: true }),
    );
    expect(interruptMarkup).toContain("aria-label=\"Stop the running turn and send this message now\"");
    expect(interruptMarkup).not.toContain("aria-label=\"Steer queued message now\"");
  });

  it("capable room chips offer the live head steer, one message at a time", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, {
        items: [
          { queueId: "q1", text: "first queued in the room" },
          { queueId: "q2", text: "second queued in the room" },
        ],
        onSteer: () => undefined,
        steerMode: "next",
        onCancel: () => undefined,
      }),
    );
    expect(markup).toContain("aria-label=\"Steer the next queued message now\"");
    expect(markup).not.toContain("Stop the running turn");
  });

  it("room chips whose engine cannot steer live say the interrupt truth", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, {
        items: [
          { queueId: "q1", text: "first queued in the room" },
          { queueId: "q2", text: "second queued in the room" },
        ],
        onSteer: () => undefined,
        steerMode: "next",
        steerInterrupts: true,
        onCancel: () => undefined,
      }),
    );
    expect(markup).toContain("aria-label=\"Stop the running turn and send the next queued message now\"");
    expect(markup).not.toContain("aria-label=\"Steer the next queued message now\"");
  });

  it("puts the queue-level Steer action on the head only and keeps every delete distinct", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, {
        items: [
          { queueId: "q1", text: "first" },
          { queueId: "q2", text: "second" },
        ],
        onSteer: () => undefined,
        steerMode: "all",
        onCancel: () => undefined,
      }),
    );

    expect(markup.match(/Steer all 2 queued messages now/g)).toHaveLength(2);
    expect(markup.match(/>Steer all</g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Delete queued message 1 of 2"');
    expect(markup).toContain('aria-label="Delete queued message 2 of 2"');
  });

  it("describes room steering as advancing the next queued message", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, {
        items: [
          { queueId: "q1", text: "first" },
          { queueId: "q2", text: "second" },
        ],
        onSteer: () => undefined,
        steerMode: "next",
        onCancel: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Steer the next queued message now"');
    expect(markup).toContain("Steer next");
  });

  it("omits Steer when this conversation cannot be interrupted", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, { items: oneItem, onCancel: () => undefined }),
    );

    expect(markup).not.toContain("Steer");
    expect(markup).toContain("actually stop at 10");
  });

  it("says it is steering and prevents a repeated interrupt", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, {
        items: oneItem,
        onSteer: () => undefined,
        steering: true,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toContain("Steering…");
    expect(markup).toContain("disabled");
  });

  it("renders nothing when the queue is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(QueuedComposerMessages, { items: [], onCancel: () => undefined }),
    );
    expect(markup).toBe("");
  });
});
