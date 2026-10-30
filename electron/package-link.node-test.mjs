import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot", "--flag", `openmausbot://install?url=${encodeURIComponent(target)}`]), target);
  });

  it("accepts a Grok Bot share link as its canonical x.ai address", () => {
    const share = "https://x.ai/bot/d8OshqLZvtcKDcNluPuyo";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(share)}`), share);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("https://www.x.ai/bot/d8OshqLZvtcKDcNluPuyo/?ref=x")}`), share);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("http://x.ai/bot/d8OshqLZvtcKDcNluPuyo")}`), null);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("https://x.ai.evil.example/bot/d8OshqLZvtcKDcNluPuyo")}`), null);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("https://x.ai/bot/marketplace")}`), null);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink("openmausbot://settings"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=http://raw.githubusercontent.com/a/b/main/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://user@example.com/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://github.com/acme/bot/run.sh"), null);
  });
});
