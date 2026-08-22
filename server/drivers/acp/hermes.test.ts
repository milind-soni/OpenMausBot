import { describe, expect, it } from "vitest";

import {
  HERMES_OPENMAUS_SCREENSHOT_COMPAT,
  HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL,
  bindHermesScreenshotCompat,
  hermesAcpModelId,
} from "./hermes.ts";

describe("hermes fleet model translation", () => {
  it("passes a guarded Hermes route alias to session/set_model", () => {
    expect(hermesAcpModelId("litellm-local:minimax-m3-light")).toBe("litellm-local:minimax-m3-light");
    expect(hermesAcpModelId("litellm-local:MiniMax-M3")).toBe("litellm-local:MiniMax-M3");
    expect(hermesAcpModelId("minimax-m3-light")).toBeNull();
  });

  it("keeps local host injection syntax and rejects malformed ids", () => {
    expect(hermesAcpModelId("ollama::qwen3:14b")).toBe("custom:ollama:qwen3:14b");
    expect(hermesAcpModelId("bad model\nnext")).toBeNull();
  });
});

describe("Hermes OpenMaus screenshot compatibility binding", () => {
  it("binds the exact leaf model for an injected local picker model", () => {
    const env = {
      [HERMES_OPENMAUS_SCREENSHOT_COMPAT]: undefined,
      [HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]: undefined,
    };

    bindHermesScreenshotCompat(env, "omlx::gemma-4-31b-it-bf16");

    expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT]).toBe("1");
    expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]).toBe("gemma-4-31b-it-bf16");
  });

  it.each([undefined, "", "anthropic/claude-opus-4.6", "unknown::model"])(
    "clears inherited compatibility for an unbound model %s",
    (model) => {
      const env = {
        [HERMES_OPENMAUS_SCREENSHOT_COMPAT]: "1",
        [HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]: "stale/model",
      };

      bindHermesScreenshotCompat(env, model);

      expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT]).toBeUndefined();
      expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]).toBeUndefined();
    },
  );
});
