import { describe, expect, it } from "vitest";

import { composerCanInjectNow } from "./ComposerInjectNow";

describe("composerCanInjectNow", () => {
  it("offers Steer only while a turn is live and a send is waiting", () => {
    expect(composerCanInjectNow(true, false, 1)).toBe(true);
    expect(composerCanInjectNow(true, false, 2)).toBe(true);
  });

  it("offers no Steer when nothing is queued", () => {
    expect(composerCanInjectNow(true, false, 0)).toBe(false);
  });

  it("does not offer Steer on an idle or locked composer", () => {
    expect(composerCanInjectNow(false, false, 1)).toBe(false);
    expect(composerCanInjectNow(true, true, 1)).toBe(false);
  });
});
