import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import type { LiveSettings } from "../shared/wire.ts";

it("saves, replaces and clears the settings Qwen credential through the real config API without exposing it or changing the native key", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.json() as { live: LiveSettings; savedKeys: Record<string, { configured: boolean }>; bots: Array<{ id: string }> } };
  };
  const disk = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  try {
    expect((await api("PATCH", "/api/config", { live: { key: "native-fixture-keep", voice: "marin" } })).status).toBe(200);
    expect((await api("PATCH", "/api/live/settings", { provider: "qwen", qwenRegion: "cn-beijing", qwenWorkspace: "", qwenModel: "qwen-audio-3.1-realtime-flash", qwenVoice: "longanqian_v3.1" })).status).toBe(200);
    for (const key of ["qwen-fixture-first-1234", "qwen-fixture-next-5678"]) {
      expect((await api("PUT", "/api/config", { live: { qwen: { key } } })).status).toBe(200);
      expect(disk().live.qwen).toMatchObject({ key, keyFor: "qwen:dashscope.aliyuncs.com", enabled: true });
      const status = await api("GET", "/api/config");
      expect(status.body.live).toMatchObject({ provider: "qwen", configured: true, qwenKeyConfigured: true, voice: "marin" });
      expect(status.body.savedKeys.qwenLiveKey).toEqual({ configured: true });
      expect(JSON.stringify(status)).not.toContain(key);
      expect(status.body.live).not.toHaveProperty("qwen");
      expect(disk().live.key).toBe("native-fixture-keep");
    }
    expect((await api("PATCH", "/api/live/settings", { qwenWorkspace: "new-workspace" })).status).toBe(200);
    expect(disk().live.qwen).toMatchObject({ key: "", keyFor: "nowhere" });
    expect((await api("PUT", "/api/config", { live: { qwen: { key: "qwen-fixture-last-9012" } } })).status).toBe(200);
    expect((await api("PUT", "/api/config", { live: { qwen: { key: "" } } })).status).toBe(200);
    expect(disk().live.qwen.key).toBe("");
    expect(disk().live.key).toBe("native-fixture-keep");
    const cleared = await api("GET", "/api/config");
    expect(cleared.body.savedKeys.qwenLiveKey).toEqual({ configured: false });
    expect(cleared.body.live.configured).toBe(false);
    const bots = await api("GET", "/api/bots");
    const botId = bots.body.bots[0].id;
    expect((await api("POST", "/api/live/session", { botId, client: "web", sdp: "offer", transports: ["ws-pcm"] })).status).toBe(409);
    expect((await api("PATCH", "/api/live/settings", { provider: "openai" })).status).toBe(200);
    expect(disk().live.provider).toBe("openai");
    expect(disk().live.qwen.enabled).toBe(false);
    expect((await api("GET", "/api/config")).body.live.configured).toBe(true);
    console.info(JSON.stringify(fixture.info));
  } finally { await fixture.close(); }
}, 30_000);
