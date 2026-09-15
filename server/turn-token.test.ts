// Per-turn tokens through stable files (the respawn fix, finding F1).
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { readTurnToken, turnTokenPath, writeTurnToken } from "./turn-token.ts";

describe("turn tokens", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("keeps the path stable per kind, bot and thread while the token rotates", () => {
    const first = writeTurnToken("comms", "bot-1", "thread-1", "token-a");
    const second = writeTurnToken("comms", "bot-1", "thread-1", "token-b");
    expect(second).toBe(first);
    expect(first).toBe(turnTokenPath("comms", "bot-1", "thread-1"));
    expect(readFileSync(first, "utf8")).toBe("token-b");
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(turnTokenPath("comms", "bot-1", "thread-2")).not.toBe(first);
    expect(turnTokenPath("browser", "bot-1", "thread-1")).not.toBe(first);
    expect(first).not.toContain("bot-1");
  });

  it("reads the current token from the file named by <ENV>_FILE, falling back to the plain env value", () => {
    const path = writeTurnToken("comms", "b", "t", "from-file\n");
    expect(readTurnToken("OMB_COMMS_TOKEN", { OMB_COMMS_TOKEN_FILE: path, OMB_COMMS_TOKEN: "stale-env" })).toBe("from-file");
    expect(readTurnToken("OMB_COMMS_TOKEN", { OMB_COMMS_TOKEN: "plain" })).toBe("plain");
    expect(readTurnToken("OMB_COMMS_TOKEN", { OMB_COMMS_TOKEN_FILE: "/nonexistent/token" })).toBe("");
    expect(readTurnToken("OMB_COMMS_TOKEN", {})).toBe("");
  });
});
