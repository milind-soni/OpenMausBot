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

it("saves, reads and clears a custom body color through the isolated HTTP routes", async () => {
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
      name: "Body color fixture", useDefaults: false, settings: { color: "yellow", mascotBodyColor: "#ABCDEF" },
    }, 201);
    expect(bot.mascotBodyColor).toBe("#abcdef");
    const path = `/api/bots/${bot.id}`;
    for (const mascotBodyColor of ["#12ab9f", null]) {
      expect((await api("PATCH", path, { mascotBodyColor })).bot.mascotBodyColor).toBe(mascotBodyColor);
      const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"));
      expect(saved.find((value: { id: string }) => value.id === bot.id).mascotBodyColor).toBe(mascotBodyColor);
    }
    await api("PATCH", path, { mascotBodyColor: "red" }, 400);
    const after = (await api("GET", "/api/bots")).bots.find((value: { id: string }) => value.id === bot.id);
    expect(after).toMatchObject({ color: "yellow", mascotBodyColor: null });
  } finally {
    await fixture.close();
  }
}, 60_000);

it("saves, reads and clears each finish through the isolated HTTP routes", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as { bot: WireBot; bots: WireBot[]; error?: string };
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const { bot } = await api("POST", "/api/bots", {
      name: "Fluffy fixture", useDefaults: false, settings: { color: "yellow", mascotBody: "blob", mascotMaterial: "fluffy" },
    }, 201);
    expect(bot.mascotMaterial).toBe("fluffy");
    const path = `/api/bots/${bot.id}`;
    for (const mascotMaterial of ["matte", "metallic", "fluffy", null]) {
      expect((await api("PATCH", path, { mascotMaterial })).bot.mascotMaterial).toBe(mascotMaterial);
      const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8"));
      expect(saved.find((value: { id: string }) => value.id === bot.id).mascotMaterial).toBe(mascotMaterial);
    }
    expect((await api("PATCH", path, { mascotMaterial: "shaggy" }, 400)).error).toBe("mascotMaterial must be fluffy, matte, metallic, or null");
    const after = (await api("GET", "/api/bots")).bots.find((value: { id: string }) => value.id === bot.id);
    expect(after).toMatchObject({ color: "yellow", mascotBody: "blob", mascotMaterial: null });
  } finally {
    await fixture.close();
  }
}, 60_000);
