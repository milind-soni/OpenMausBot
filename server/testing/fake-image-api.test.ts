import { expect, it } from "vitest";
import { startFakeImageApi } from "./fake-image-api.ts";

it("rejects when its port is taken, instead of never settling", async () => {
  const first = await startFakeImageApi();
  try {
    await expect(startFakeImageApi({ port: Number(new URL(first.url).port) })).rejects.toThrow(/EADDRINUSE/);
  } finally {
    await first.stop();
  }
});
