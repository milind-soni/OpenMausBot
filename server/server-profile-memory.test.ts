// Its own file: the rule is one switch for the whole process (server/workspace.ts), so nothing else may flip it first.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { startServerProfile } from "./server-profile-boot.ts";
import { readMemoryText } from "./workspace.ts";

const root = mkdtempSync(join(tmpdir(), "omb-profile-memory-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Windows needs a privilege to make a link, and has no bot box to turn the profile on.
describe.skipIf(process.platform === "win32")("memory in the hardened profile", () => {
  it("is read only from regular files once the profile is on, so a bot's link cannot hand it the server's settings", async () => {
    const settings = join(root, "config.json"), link = join(root, "MEMORY.md"), own = join(root, "notes.md");
    writeFileSync(settings, '{"anthropic":{"key":"sk-ant-canary"}}');
    writeFileSync(own, "the bot's own notes");
    symlinkSync(settings, link);
    const boot = (env: NodeJS.ProcessEnv, box: "bwrap" | "off") => startServerProfile({
      dataDir: root, port: 1, cloudHome: false, env, platform: "linux", fromSource: false, log: () => {},
      startBox: async () => ({ box, reason: box === "off" ? "not-cloud" : null }),
    });

    await boot({}, "off");
    expect(readMemoryText(link)).toContain("sk-ant-canary");

    await boot({ OMB_IMAGE: "server" }, "bwrap");
    expect(() => readMemoryText(link)).toThrow();
    expect(readMemoryText(own)).toBe("the bot's own notes");
  });
});
