import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/openindbot/dist-server/openindbot.js")).toBe("npx openindbot");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("openindbot");
    expect(cliPrefix({ npm_lifecycle_event: "omb" }, "/repo/server/openindbot.ts")).toBe("pnpm omb");
    expect(cliPrefix({ OMB_CLI_PREFIX: "docker compose exec omb openindbot" }, "/app/dist-server/openindbot.js")).toBe("docker compose exec omb openindbot");
    expect(cliPrefix({}, "/usr/lib/node_modules/openindbot/dist-server/openindbot.js")).toBe("openindbot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\openindbot\\x.js")).toBe("npx openindbot pair");
  });
});
