import { describe, expect, it } from "vitest";
import { BUDDY_EYES, moodFor } from "@/components/BuddyAvatar";
import { MAUS_STATES, normalizeState, PICKABLE_STATES, stateForBot, stateForTool } from "./mascot";

const buddy = (extra: Parameters<typeof stateForBot>[0] extends infer T ? Partial<T> : never = {}) => ({
  name: "Yv",
  title: "CEO",
  description: "",
  mascotExpression: "sleeping",
  ...extra,
});
const running = (name: string) => ({ kind: "activity", role: "bot", tool: { name } });

describe("Buddy eye placement", () => {
  it("matches the placement guide on the 1024 canvas", () => {
    expect(BUDDY_EYES.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [210, 284, 183, 292],
      [472.744186, 284, 183, 292],
    ]);
  });

  it("draws each eye inside its guide box, 80.5 apart", () => {
    // the eye path spans x 187..319 and y 341..599
    const drawn = BUDDY_EYES.map((eye) => {
      const [a, , , d, e, f] = eye.transform.slice(7, -1).split(",").map(Number);
      return { left: a * 187 + e, right: a * 319 + e, top: d * 341 + f, bottom: d * 599 + f };
    });
    drawn.forEach((box, index) => {
      const eye = BUDDY_EYES[index];
      expect(box.left).toBeCloseTo(eye.x, 2);
      expect(box.top).toBeCloseTo(eye.y, 2);
      expect(box.bottom).toBeCloseTo(eye.y + eye.height, 2);
      expect(eye.x + eye.width - box.right).toBeLessThan(1);
    });
    expect(drawn[1].left - drawn[0].right).toBeCloseTo(80.5, 0);
  });
});

describe("stateForBot", () => {
  it("shows live work over a saved resting expression", () => {
    expect(stateForBot(buddy({ busy: true }))).toBe("working");
  });

  it("falls back to the saved expression when nothing is happening", () => {
    expect(stateForBot(buddy())).toBe("sleeping");
  });

  it("tells thinking from writing", () => {
    expect(stateForBot(buddy({ busy: true }), { reasoning: true })).toBe("thinking");
    expect(stateForBot(buddy({ busy: true }), { reasoning: true, writing: true })).toBe("writing");
  });

  it("recognises Preview, tests and searches from the running tool", () => {
    expect(stateForBot(buddy({ busy: true, messages: [running("mcp__agents__preview_snapshot")] }))).toBe("preview");
    expect(stateForBot(buddy({ busy: true, messages: [running("/bin/zsh -lc 'pnpm test'")] }))).toBe("testing");
    expect(stateForBot(buddy({ busy: true, messages: [running("Grep")] }))).toBe("searching");
    expect(stateForBot(buddy({ busy: true, messages: [running("Edit")] }))).toBe("working");
  });

  it("shows Preview while its session is open during a turn, not after", () => {
    expect(stateForBot(buddy({ busy: true }), { preview: { state: "ready" } })).toBe("preview");
    expect(stateForBot(buddy({ busy: true }), { preview: { state: "opening" } })).toBe("connecting");
    expect(stateForBot(buddy(), { preview: { state: "ready" } })).toBe("sleeping");
  });

  it("asks for attention on an open question or approval", () => {
    const ask = { kind: "options", role: "bot", card: { requestId: "r1" } };
    expect(stateForBot(buddy({ busy: true, messages: [ask] }))).toBe("attention");
    expect(stateForBot(buddy({ messages: [{ ...ask, card: { requestId: "r1", answered: "Yes" } }] }))).toBe("sleeping");
    expect(stateForBot(buddy({ busy: true }), { roomStatus: "approval" })).toBe("attention");
    expect(stateForBot(buddy({ busy: true }), { preview: { state: "error" } })).toBe("attention");
  });

  it("separates errors from usage limits", () => {
    const failed = (name: string) => [{ kind: "activity", role: "bot", tool: { name, ok: false } }];
    expect(stateForBot(buddy({ messages: failed("error: claude exited 143") }))).toBe("error");
    expect(stateForBot(buddy({ messages: failed("This AI app’s usage ran out.") }))).toBe("limited");
    expect(stateForBot(buddy(), { roomStatus: "failed" })).toBe("error");
    // what a real usage-limit turn leaves behind: the failed step, then a notice
    const turn = [
      { kind: "text", role: "user" },
      { kind: "activity", role: "bot", tool: { name: "This AI app’s usage ran out.", ok: false } },
      { kind: "activity", role: "bot", tool: { name: "Claude’s usage ran out, so I stopped here." } },
    ];
    expect(stateForBot(buddy({ unread: true, messages: turn }))).toBe("limited");
    // a new message starts a new turn; the old failure no longer shows
    expect(stateForBot(buddy({ messages: [...turn, { kind: "text", role: "user" }] }))).toBe("sleeping");
  });

  it("shows room queueing and unread replies", () => {
    expect(stateForBot(buddy(), { queued: true })).toBe("queued");
    expect(stateForBot(buddy(), { roomBusy: true })).toBe("working");
    expect(stateForBot(buddy({ unread: true }))).toBe("notifying");
  });

  it("never infers a busy look from a Buddy's role", () => {
    const developer = { name: "SoSo", title: "Developer", description: "writes code" };
    expect(stateForBot(developer)).toBe("proud");
    expect(stateForBot({ name: "Plain" })).toBe("idle");
  });
});

describe("state vocabulary", () => {
  it("still reads names earlier avatars saved", () => {
    expect(normalizeState("friendly")).toBe("happy");
    expect(normalizeState("radar")).toBe("radar");
    expect(normalizeState("nonsense")).toBeNull();
  });

  it("gives every state a drawable mood", () => {
    for (const state of MAUS_STATES) expect(moodFor(state)).toMatch(/^[a-z]+$/);
  });

  it("offers only resting looks in the picker", () => {
    expect(PICKABLE_STATES).not.toContain("working");
    expect(new Set(PICKABLE_STATES.map(moodFor)).size).toBe(PICKABLE_STATES.length);
  });

  it("classifies tool names", () => {
    expect(stateForTool("preview_action")).toBe("preview");
    expect(stateForTool("/bin/zsh -lc 'pnpm typecheck'")).toBe("testing");
    expect(stateForTool("Write")).toBeNull();
  });
});
