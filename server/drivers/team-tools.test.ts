import { describe, expect, it } from "vitest";

import { chatNotice } from "../chat-notices.ts";
import { eduMemoryFailed, eduMemoryNotice, teamToolsFailed } from "./team-tools.ts";

describe("eduMemoryNotice", () => {
  const HOUR = 60 * 60 * 1000;

  it("says it once an hour in a thread, each thread on its own", () => {
    const line = { message: chatNotice("chat.notice.eduMemoryFailed"), text: { key: "chat.notice.eduMemoryFailed" } };
    expect(line.message).toBe("Edu memory didn't connect this time; it retries next message.");
    expect(eduMemoryNotice("thread-a", 1_000)).toEqual(line);
    expect(eduMemoryNotice("thread-a", 1_000 + HOUR - 1)).toBeNull();
    expect(eduMemoryNotice("thread-b", 1_000 + HOUR - 1)).toEqual(line);
    expect(eduMemoryNotice("thread-a", 1_000 + HOUR)).toEqual(line);
    expect(eduMemoryNotice("thread-a", 1_000 + HOUR + 5)).toBeNull();
  });
});

describe("startup states", () => {
  it("tells a failed edu server from a failed agents server and from one still starting", () => {
    expect(eduMemoryFailed({ name: "edu", status: "failed" })).toBe(true);
    expect(eduMemoryFailed({ name: "edu", status: "starting" })).toBe(false);
    expect(eduMemoryFailed({ name: "agents", status: "failed" })).toBe(false);
    expect(teamToolsFailed({ name: "edu", status: "failed" })).toBe(false);
    expect(eduMemoryFailed(null)).toBe(false);
  });
});
