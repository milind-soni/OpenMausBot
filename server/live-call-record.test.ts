import { describe, expect, it } from "vitest";

import { spokenLineFields } from "./live-call-record.ts";

describe("spokenLineFields", () => {
  it("stamps a spoken line with its call, and only a spoken line", () => {
    expect(spokenLineFields("call", "call-1")).toEqual({ via: "call", callId: "call-1" });
    expect(spokenLineFields("call", undefined)).toEqual({ via: "call" });
    expect(spokenLineFields("call", "")).toEqual({ via: "call" });
    expect(spokenLineFields("api", "call-1")).toEqual({});
    expect(spokenLineFields(undefined, "call-1")).toEqual({});
  });
});
