import { describe, expect, it } from "vitest";

import { hermesAcpModelId } from "./hermes.ts";

describe("hermes fleet model translation", () => {
  it("passes a guarded Hermes route alias to session/set_model", () => {
    expect(hermesAcpModelId("litellm-local:minimax-m3-light")).toBe("litellm-local:minimax-m3-light");
    expect(hermesAcpModelId("litellm-local:MiniMax-M3")).toBe("litellm-local:MiniMax-M3");
    expect(hermesAcpModelId("minimax-m3-light")).toBeNull();
  });

  it("keeps local host injection syntax and rejects malformed ids", () => {
    expect(hermesAcpModelId("ollama::qwen3:14b")).toBe("custom:ollama:qwen3:14b");
    expect(hermesAcpModelId("bad model\nnext")).toBeNull();
    expect(hermesAcpModelId("litellm-local:qwen\n")).toBeNull();
  });
});
