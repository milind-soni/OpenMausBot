import { describe, expect, it } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };
import { codedLine, fittedLine, ROUTINE_LINE, routineLine } from "./routine-lines.ts";

it("the catalog's routine lines are exactly the ones the server stores", () => {
  const catalog = Object.fromEntries(Object.entries(englishCatalog).filter(([key]) => key.startsWith("routines.server.")));
  expect(catalog).toEqual(ROUTINE_LINE);
});

it("words a part a line names in its English", () => {
  expect(routineLine("routines.server.retryAfter", { why: "routines.server.part.stalled", failure: "x" })).toBe("Starting again shortly after the AI stalled: x");
});

const SECRET = `ghp_${"Z9y8".repeat(6)}`;

it("scrubs a quoted failure in the line and in its params alike", () => {
  const line = codedLine("error", "routines.server.failedAfterRetry", { failure: `token ${SECRET}` });
  expect(JSON.stringify(line)).not.toContain(SECRET);
  expect(JSON.stringify(fittedLine("error", `x ${SECRET}`, { key: "chat.notice.usageLimit", params: { provider: "Grok", detail: SECRET } }))).not.toContain(SECRET);
});

describe("a long line", () => {
  const retry = (failure: string) => `Starting again shortly after a temporary error: ${failure}`.slice(0, 500);
  const busy = (failure: string) => `Did not start: still busy after 60 minutes (${failure})`.slice(0, 500);
  const signedOut = (failure: string) => `This bot's AI is signed out. Sign in again in Settings → AI. The AI said: “${failure}”`.slice(0, 500);

  it.each([470, 500, 1000])("stores the old first 500 characters of a line ending in its failure, with a code that rebuilds them (%i)", (length) => {
    const failure = "x".repeat(length);
    const line = codedLine("attention", "routines.server.retryAfter", { why: "routines.server.part.provider", failure });
    expect(line.text).toBe(retry(failure));
    expect(line.codes.attentionCode).toBe("routines.server.retryAfter");
    expect(routineLine("routines.server.retryAfter", line.codes.attentionParams)).toBe(line.text);
  });

  it.each([1000, 470])("stores the old cut, and no code, where the cut lands where params cannot rebuild it (%i)", (length) => {
    const failure = "x".repeat(length);
    const stalled = codedLine("error", "routines.server.stillBusy", { minutes: 60, failure });
    expect(stalled.text).toBe(busy(failure));
    const out = codedLine("error", "routines.server.signedOut", { failure });
    expect(out.text).toBe(signedOut(failure));
    expect([stalled.codes.errorCode, out.codes.errorCode]).toEqual([undefined, undefined]);
  });

  it("keeps the code when nothing is cut", () => {
    expect(codedLine("error", "routines.server.stillBusy", { minutes: 60, failure: "busy" })).toEqual({
      text: "Did not start: still busy after 60 minutes (busy)", codes: { errorCode: "routines.server.stillBusy", errorParams: { minutes: 60, failure: "busy" } },
    });
  });
});
