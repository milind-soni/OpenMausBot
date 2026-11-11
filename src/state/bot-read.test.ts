import { describe, expect, it, vi } from "vitest";
import { NO_SUCH_BOT } from "../../shared/bot-read";
import { ApiError } from "./api";
import { readOneBot } from "./bot-read";
import type { BotAnnouncement } from "./store";

const bot = (id: string) => ({ id, threadId: `${id}-thread`, name: id }) as BotAnnouncement;

describe("reading one bot to reconcile it", () => {
  it("asks for that bot alone", async () => {
    const read = vi.fn(async () => ({ bot: bot("scout") }) as never);
    expect(await readOneBot("scout", 200, undefined, read)).toEqual(bot("scout"));
    expect(read.mock.calls.map(([path]) => path)).toEqual(["/api/bots/scout?messages=200"]);
  });

  it("answers null for a bot the server no longer has, without reading every bot", async () => {
    const read = vi.fn(async () => { throw new ApiError(NO_SUCH_BOT, 404, { error: NO_SUCH_BOT }); });
    expect(await readOneBot("gone", 200, undefined, read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads the list from a server without the one-bot read", async () => {
    const read = vi.fn(async (path: string) => {
      if (path.startsWith("/api/bots/")) throw new ApiError("not found", 404, { error: "not found" });
      return { bots: [bot("other"), bot("scout")] } as never;
    });
    expect(await readOneBot("scout", 200, undefined, read)).toEqual(bot("scout"));
    expect(read.mock.calls.map(([path]) => path)).toEqual(["/api/bots/scout?messages=200", "/api/bots?messages=200"]);
  });

  it("passes any other failure on", async () => {
    const read = vi.fn(async () => { throw new ApiError("offline", 503); });
    await expect(readOneBot("scout", 200, undefined, read)).rejects.toThrow("offline");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
