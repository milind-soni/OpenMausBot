import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot", "--flag", `openmausbot://install?url=${encodeURIComponent(target)}`]), target);
  });

  it("converts an exact Grok Bot app link into the public importer URL", () => {
    const id = "KZ9xav0Qad1U5QigEn7rh";
    const deepLink = `grokbot://app/v1/bot-template?id=${id}`;
    assert.equal(packageUrlFromDeepLink(deepLink), `https://x.ai/bot/${id}`);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot.exe", deepLink]), `https://x.ai/bot/${id}`);
  });

  it("rejects malformed or expanded Grok Bot app links", () => {
    const id = "KZ9xav0Qad1U5QigEn7rh";
    assert.equal(packageUrlFromDeepLink(`grokbot://other/v1/bot-template?id=${id}`), null);
    assert.equal(packageUrlFromDeepLink(`grokbot://app/v2/bot-template?id=${id}`), null);
    assert.equal(packageUrlFromDeepLink(`grokbot://app/v1/bot-template?id=${id}&next=https://evil.example`), null);
    assert.equal(packageUrlFromDeepLink(`grokbot://app/v1/bot-template?id=short`), null);
    assert.equal(packageUrlFromDeepLink(`grokbot://app/v1/bot-template?id=${id}#fragment`), null);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink("openmausbot://settings"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=http://raw.githubusercontent.com/a/b/main/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://user@example.com/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://github.com/acme/bot/run.sh"), null);
  });
});
