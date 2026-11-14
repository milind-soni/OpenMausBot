import { describe, expect, it } from "vitest";

import { BOT_API_KEY_PLACEHOLDER, botApiCurl, botApiEndpoint } from "./bot-api.ts";

describe("the Bot API's address and command", () => {
  it("sits under the webhook receiver's /hooks path, whatever base the app advertises", () => {
    expect(botApiEndpoint("https://scout.mausbot.cloud", "b1")).toBe("https://scout.mausbot.cloud/hooks/api/bots/b1/messages");
    expect(botApiEndpoint("http://127.0.0.1:8800/", "b 1")).toBe("http://127.0.0.1:8800/hooks/api/bots/b%201/messages");
  });

  it("is one pasteable curl: the key where the caller's goes, YOUR_KEY once the key is gone", () => {
    const withKey = botApiCurl("https://x/hooks/api/bots/b1/messages", "bak_abc");
    expect(withKey).toContain('-H "Authorization: Bearer bak_abc"');
    expect(withKey).toContain(`-d '{"message": "Hello! What can you do?"}'`);
    expect(withKey.startsWith('curl -X POST "https://x/hooks/api/bots/b1/messages"')).toBe(true);
    expect(botApiCurl("https://x/hooks/api/bots/b1/messages")).toContain(`Bearer ${BOT_API_KEY_PLACEHOLDER}`);
    for (const line of withKey.split("\n").slice(0, -1)) expect(line.endsWith(" \\")).toBe(true);
  });
});
