// What crosses from the launching shell into a fixture server: only what a
// test scripted on purpose. A real OpenAI key must never reach a fixture that
// could send it to OpenAI.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "./control-omb.ts";

const childEnv = (parentEnv: NodeJS.ProcessEnv) => verificationServerEnvironment(parentEnv, join(tmpdir(), "omb-fixture-env"), 9100);

describe("the fixture's Live call environment", () => {
  it("passes a loopback fake GPT-Live and its key through", () => {
    expect(childEnv({ OMB_OPENAI_LIVE_URL: " http://127.0.0.1:4100 ", OMB_OPENAI_LIVE_KEY: "sk-fake" }))
      .toMatchObject({ OMB_OPENAI_LIVE_URL: "http://127.0.0.1:4100", OMB_OPENAI_LIVE_KEY: "sk-fake" });
    const noKey = childEnv({ OMB_OPENAI_LIVE_URL: "http://127.0.0.1:4100" });
    expect(noKey.OMB_OPENAI_LIVE_URL).toBe("http://127.0.0.1:4100");
    expect(noKey).not.toHaveProperty("OMB_OPENAI_LIVE_KEY");
  });

  it("drops any other Live URL, and never lets the key cross without the fake", () => {
    for (const url of ["https://api.openai.com", "http://localhost:4100", "http://127.0.0.1:4100/v1", "http://192.0.2.1:4100", "http://127.0.0.1", ""]) {
      const env = childEnv({ OMB_OPENAI_LIVE_URL: url, OMB_OPENAI_LIVE_KEY: "sk-real" });
      expect(env, url).not.toHaveProperty("OMB_OPENAI_LIVE_URL");
      expect(env, url).not.toHaveProperty("OMB_OPENAI_LIVE_KEY");
    }
    expect(childEnv({ OMB_OPENAI_LIVE_KEY: "sk-real" })).not.toHaveProperty("OMB_OPENAI_LIVE_KEY");
  });

  // Live calls need Pro. A recipe that starts calls says so with
  // OMB_PRO_PLAN=1; without it the fixture refuses them (402 needsPro).
  it("lets the Pro answer cross only as OMB_PRO_PLAN=1", () => {
    expect(childEnv({ OMB_PRO_PLAN: "1" })).toMatchObject({ OMB_PRO_PLAN: "1" });
    for (const value of [undefined, "", "0", "true", "yes"]) expect(childEnv({ OMB_PRO_PLAN: value }), String(value)).not.toHaveProperty("OMB_PRO_PLAN");
  });
});
