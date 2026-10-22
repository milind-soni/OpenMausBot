import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { browserSessionId } from "../browser-engine.ts";
import { AudienceBrowsers, audienceBrowserSuffix } from "./audience.ts";

const SOCKET_DIR = "/data/.agent-browser/";
const BOT = "0b8e2c4e-6c8f-4d0b-9e64-2f7a1c3d5e6f";

describe("the name an audience gives a bot's browser", () => {
  it("is the bot's own for the team, and one of the member's or the group chat's own otherwise", () => {
    expect(audienceBrowserSuffix("team")).toBe("");
    expect(audienceBrowserSuffix("member:p_AbC-12")).toMatch(/^--member-[0-9a-f]{16}$/);
    expect(audienceBrowserSuffix("room:6f1c")).toMatch(/^--room-[0-9a-f]{16}$/);
    expect(audienceBrowserSuffix("member:p_ada")).toBe(audienceBrowserSuffix("member:p_ada"));
    expect(audienceBrowserSuffix("member:p_ada")).not.toBe(audienceBrowserSuffix("member:p_cleo"));
    expect(audienceBrowserSuffix("room:x").slice(-16)).toBe(audienceBrowserSuffix("member:x").slice(-16));
    expect(audienceBrowserSuffix("room:x")).not.toBe(audienceBrowserSuffix("member:x"));
  });

  it("keeps agent-browser's socket path on a Cloud home under its 103 bytes, for a bot's or a shared profile's browser", () => {
    const longest = ["room:0b8e2c4e-6c8f-4d0b-9e64-2f7a1c3d5e6f", `member:p_${"x".repeat(22)}`, `room:${"g".repeat(200)}`] as const;
    for (const audience of longest) {
      for (const session of [browserSessionId(BOT + audienceBrowserSuffix(audience), ""), browserSessionId("", "p".repeat(40) + audienceBrowserSuffix(audience))]) {
        expect(session).toMatch(/^[A-Za-z0-9_.-]{1,96}$/);
        expect(`${SOCKET_DIR}${session}.sock`.length, session).toBeLessThanOrEqual(103);
      }
    }
  });
});

describe("which audiences have had a browser", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "omb-audience-browsers-")), "browser", "audiences.json");

  it("starts with the team's alone, keeps each new suffix on disk once, and reads it back after a restart", () => {
    const path = file();
    const kept = new AudienceBrowsers(path);
    expect(kept.variants()).toEqual([""]);
    const ada = audienceBrowserSuffix("member:p_ada"), room = audienceBrowserSuffix("room:launch");
    kept.note("");
    kept.note(ada);
    kept.note(ada);
    kept.note(room);
    expect(kept.variants()).toEqual(["", ada, room]);
    expect(new AudienceBrowsers(path).variants()).toEqual(["", ada, room]);
  });

  it("drops what is not a suffix it writes, and refuses to write one", () => {
    const path = file();
    const ada = audienceBrowserSuffix("member:p_ada"), room = audienceBrowserSuffix("room:launch");
    new AudienceBrowsers(path).note(ada);
    writeFileSync(path, JSON.stringify({ suffixes: [ada, "../../etc", 7, room, "--member-p_ada"] }));
    expect(new AudienceBrowsers(path).variants()).toEqual(["", ada, room]);
    expect(() => new AudienceBrowsers(path).note("--member-../x")).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).suffixes).toContain("../../etc");
  });
});
