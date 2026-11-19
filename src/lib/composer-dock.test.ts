import { describe, expect, it } from "vitest";

import { messageBoxHeight, TRANSCRIPT_GAP, transcriptEndPad } from "./composer-dock";

describe("transcriptEndPad", () => {
  it("adds one gap-3 of black above the measured composer", () => {
    expect(TRANSCRIPT_GAP).toBe("0.75rem");
    expect(transcriptEndPad(72)).toBe("calc(72px + 0.75rem)");
  });

  it("ceils fractional heights so a subpixel composer cannot eat the gap", () => {
    expect(transcriptEndPad(71.2)).toBe("calc(72px + 0.75rem)");
  });

  it("does not go negative", () => {
    expect(transcriptEndPad(-4)).toBe("calc(0px + 0.75rem)");
  });

  it("uses a one-line empty-composer fallback, not the old two-row slot", () => {
    expect(transcriptEndPad(Number.NaN)).toBe("calc(64px + 0.75rem)");
  });
});

describe("messageBoxHeight", () => {
  it("leaves out what is stacked above the message box, so an open page is not squeezed by attachments", () => {
    expect(messageBoxHeight({ bottom: 900 }, { top: 840 })).toBe(60);
  });

  it("is zero without a message box, and never negative", () => {
    expect(messageBoxHeight({ bottom: 900 }, undefined)).toBe(0);
    expect(messageBoxHeight({ bottom: 900 }, { top: 910 })).toBe(0);
  });
});
