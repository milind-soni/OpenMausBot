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
});

describe("the fixture's X research relay", () => {
  it("passes a loopback relay stub and its token through, the token only with the stub", () => {
    expect(childEnv({ OMB_CLOUD_X_URL: " http://127.0.0.1:4200/api/cloud/services/x ", OMB_CLOUD_X_TOKEN: "omb_x_fixture" }))
      .toMatchObject({ OMB_CLOUD_X_URL: "http://127.0.0.1:4200/api/cloud/services/x", OMB_CLOUD_X_TOKEN: "omb_x_fixture" });
    for (const url of ["https://cloud.openmausbot.com/api/cloud/services/x", "http://localhost:4200/api/cloud/services/x", "http://192.0.2.1:4200", "http://127.0.0.1:4200/../x?y", ""]) {
      const env = childEnv({ OMB_CLOUD_X_URL: url, OMB_CLOUD_X_TOKEN: "omb_x_real" });
      expect(env, url).not.toHaveProperty("OMB_CLOUD_X_URL");
      expect(env, url).not.toHaveProperty("OMB_CLOUD_X_TOKEN");
    }
    expect(childEnv({ OMB_TREG_URL: "http://127.0.0.1:4200" })).not.toHaveProperty("OMB_TREG_URL");
  });
});
