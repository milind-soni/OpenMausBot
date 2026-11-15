import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/obot/dist-server/obot.js")).toBe("npx obot");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("obot");
    expect(cliPrefix({ npm_lifecycle_event: "omb" }, "/repo/server/obot.ts")).toBe("pnpm omb");
    expect(cliPrefix({ OMB_CLI_PREFIX: "docker compose exec omb obot" }, "/app/dist-server/obot.js")).toBe("docker compose exec omb obot");
    expect(cliPrefix({}, "/usr/lib/node_modules/obot/dist-server/obot.js")).toBe("obot");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\obot\\x.js")).toBe("npx obot pair");
  });
});
