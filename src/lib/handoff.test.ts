import { describe, expect, it } from "vitest";

import type { SignInRequestCardData } from "../../shared/wire";
import { handoffEnd, handoffSummary, newestWaitingHandoff, PILL_ACTION, viewerPillState } from "./handoff";

const card = (fields: Partial<SignInRequestCardData> = {}): SignInRequestCardData =>
  ({ url: "", site: "", place: "browser", instruction: "Solve the check.", need: "captcha", ...fields });

describe("the viewer's one pill", () => {
  it("watches until the person is in control", () => {
    expect(viewerPillState({ inControl: false, requestPending: false })).toBe("watching");
    expect(viewerPillState({ inControl: false, requestPending: true })).toBe("watching");
    expect(PILL_ACTION.watching).toBe("take");
  });

  it("offers Stop for control the person took, and I'm done while a request waits", () => {
    expect(viewerPillState({ inControl: true, requestPending: false })).toBe("control");
    expect(PILL_ACTION.control).toBe("stop");
    expect(viewerPillState({ inControl: true, requestPending: true })).toBe("control-request");
    expect(PILL_ACTION["control-request"]).toBe("done");
  });
});

describe("how a handoff ended", () => {
  it.each([
    [{}, null],
    [{ done: true }, "done"],
    [{ cancelled: true }, "skipped"],
    [{ expired: true }, "expired"],
    [{ answeredInChat: true }, "chat"],
    [{ stopped: true }, "stopped"],
    [{ superseded: true }, "replaced"],
  ] as const)("%o is %s", (fields, end) => {
    expect(handoffEnd(card(fields))).toBe(end);
  });

  it("folds to the outcome and the step", () => {
    expect(handoffSummary("done", "Sign in to GitHub.")).toBe("Done · Sign in to GitHub.");
    expect(handoffSummary("expired", "Sign in to GitHub.")).toBe("Expired · Sign in to GitHub.");
  });
});

describe("which open request shows the live picture", () => {
  it("is the newest handoff still waiting", () => {
    const rows = [
      { id: "a", kind: "signin", signIn: card() },
      { id: "b", kind: "signin", signIn: card() },
      { id: "c", kind: "signin", signIn: card({ done: true }) },
      { id: "d", kind: "signin", signIn: { url: "https://x.example", site: "x.example", place: "browser" as const } },
      { id: "e", kind: "text" },
    ];
    expect(newestWaitingHandoff(rows)).toBe("b");
    expect(newestWaitingHandoff(rows.slice(0, 1))).toBe("a");
    expect(newestWaitingHandoff([{ id: "s", kind: "signin", signIn: card({ stopped: true }) }])).toBeNull();
  });
});
