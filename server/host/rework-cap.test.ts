import { describe, expect, it } from "vitest";

import { createReworkCap, REWORK_MAX } from "./rework-cap.ts";

describe("rework cap", () => {
  it("refuses rework past the limit to one teammate under one request, and counts each request and teammate apart", () => {
    const cap = createReworkCap(() => 0);
    const name = (id: string) => (id === "vera" ? "Vera" : id);
    for (let round = 0; round < REWORK_MAX; round++) expect(cap.take("request-1", ["vera"], name)).toBeNull();
    expect(cap.take("request-1", ["vera"], name)).toContain("past the limit of 4, so nothing was sent. Stop here: give the person the latest result");
    expect(cap.take("request-1", ["vera", "other"], name)).toContain("sent to Vera");
    expect(cap.take("request-1", ["other"], name)).toBeNull();
    expect(cap.take("request-2", ["vera"], name)).toBeNull();
  });

  it("forgets a request after six hours", () => {
    let clock = 0;
    const cap = createReworkCap(() => clock);
    for (let round = 0; round < REWORK_MAX; round++) cap.take("request-1", ["vera"], String);
    clock = 6 * 60 * 60_000 + 1;
    expect(cap.take("request-1", ["vera"], String)).toBeNull();
  });
});
