import { describe, expect, it, vi } from "vitest";

import { assemblyAICredential, mintAssemblyAIStreamingToken } from "./assemblyai.mjs";

describe("AssemblyAI credential boundary", () => {
  it("prefers the OS-encrypted credential over a development environment value", () => {
    expect(assemblyAICredential({ assemblyAiApiKey: " stored " }, { ASSEMBLYAI_API_KEY: "env" }))
      .toBe("stored");
  });

  it("mints a bounded temporary token without putting the permanent key in the URL", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "temporary" }),
    }));
    await expect(mintAssemblyAIStreamingToken("permanent", { fetchImpl, expiresInSeconds: 900 }))
      .resolves.toEqual({ token: "temporary", expiresInSeconds: 600 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://streaming.assemblyai.com/v3/token?expires_in_seconds=600",
      {
        headers: { authorization: "permanent" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("returns a useful error without exposing an upstream response body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "upstream secret-shaped detail" }),
    }));
    await expect(mintAssemblyAIStreamingToken("wrong", { fetchImpl }))
      .rejects.toThrow("AssemblyAI rejected this API key");
  });
});
