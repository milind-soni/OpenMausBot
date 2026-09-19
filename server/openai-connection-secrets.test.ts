import { describe, expect, it } from "vitest";
import { readOpenAIConnectionKey, removeOpenAIConnectionKey, setOpenAIConnectionKey } from "./openai-connection-secrets.ts";

describe("external OpenAI connection keys", () => {
  const urlA = "https://a.example/v1";
  const urlB = "https://b.example/v1";
  it("isolates credentials during independent rotation and removal", () => {
    const env: NodeJS.ProcessEnv = {};
    setOpenAIConnectionKey("api-a", "key-a", urlA, env);
    setOpenAIConnectionKey("api-b", "key-b", urlB, env);
    setOpenAIConnectionKey("api-a", "rotated-a", urlA, env);
    expect(readOpenAIConnectionKey("api-a", urlA, env)).toBe("rotated-a");
    expect(readOpenAIConnectionKey("api-b", urlB, env)).toBe("key-b");
    expect(readOpenAIConnectionKey("missing", urlA, env)).toBeUndefined();
    expect(readOpenAIConnectionKey("constructor", urlA, env)).toBeUndefined();
    removeOpenAIConnectionKey("api-a", env);
    expect(readOpenAIConnectionKey("api-a", urlA, env)).toBeUndefined();
    expect(readOpenAIConnectionKey("api-b", urlB, env)).toBe("key-b");
    removeOpenAIConnectionKey("api-b", env);
    expect(env.OPENMAUS_OPENAI_CONNECTION_KEYS).toBeUndefined();
  });

  it.each(["invalid-json", "[]", "null", '{"api-a":42,"api-b":"","api-c":"key-c"}'])(
    "ignores malformed entries without returning a different connection's credential (%s)", raw => {
      expect(readOpenAIConnectionKey("api-a", urlA, { OPENMAUS_OPENAI_CONNECTION_KEYS: raw })).toBeUndefined();
    },
  );

  it("fails closed after a crash leaves the encrypted key bound to a different endpoint", () => {
    const env: NodeJS.ProcessEnv = {};
    setOpenAIConnectionKey("api-a", "new-provider-key", urlB, env);
    expect(readOpenAIConnectionKey("api-a", urlA, env)).toBeUndefined();
    expect(readOpenAIConnectionKey("api-a", "https://B.example:443/v1/", env)).toBe("new-provider-key");
    expect(readOpenAIConnectionKey("api-a", "https://b.example/other", env)).toBeUndefined();
  });
});
