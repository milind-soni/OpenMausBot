import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";

it("saves, reads and resets facial feature color through the isolated HTTP routes", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as { bot: WireBot; bots: WireBot[] };
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const { bot } = await api("POST", "/api/bots", {
      name: "Face color fixture", useDefaults: false, settings: { color: "yellow", mascotFaceColor: "black" },
    }, 201);
    expect(bot.mascotFaceColor).toBe("black");
    const path = `/api/bots/${bot.id}`;
    for (const mascotFaceColor of ["white", "black", null]) {
      expect((await api("PATCH", path, { mascotFaceColor })).bot.mascotFaceColor).toBe(mascotFaceColor);
      expect((await api("GET", "/api/bots")).bots.find((value: { id: string }) => value.id === bot.id)?.mascotFaceColor).toBe(mascotFaceColor);
      const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"));
      expect(saved.find((value: { id: string }) => value.id === bot.id).mascotFaceColor).toBe(mascotFaceColor);
    }
    await api("PATCH", path, { mascotFaceColor: "red" }, 400);
    const after = (await api("GET", "/api/bots")).bots.find((value: { id: string }) => value.id === bot.id);
    expect(after).toMatchObject({ color: "yellow", mascotFaceColor: null });
  } finally {
    await fixture.close();
  }
}, 60_000);
