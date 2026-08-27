import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOPIC_CARD, TOPIC_ROBOT } from "dingtalk-stream";

describe("pinned DingTalk Stream SDK", () => {
  it("uses the registry-published exact latest and verified callback topics", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies["dingtalk-stream"]).toBe("2.1.6-beta.1");
    expect(TOPIC_ROBOT).toBe("/v1.0/im/bot/messages/get");
    expect(TOPIC_CARD).toBe("/v1.0/card/instances/callback");
  });
});
