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
  const qwenKeyTarget = { region: "cn-beijing", workspace: "" };
  try {
    expect((await api("PATCH", "/api/config", { live: { key: "native-fixture-keep", voice: "marin" } })).status).toBe(200);
    expect((await api("PATCH", "/api/live/settings", { provider: "qwen", qwenRegion: "cn-beijing", qwenWorkspace: "", qwenModel: "qwen-audio-3.1-realtime-flash", qwenVoice: "longanqian_v3.1" })).status).toBe(200);
    for (const key of ["qwen-fixture-first-1234", "qwen-fixture-next-5678"]) {
      expect((await api("PUT", "/api/config", { live: { qwen: { key } }, qwenKeyTarget })).status).toBe(200);
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
    expect((await api("PUT", "/api/config", { live: { qwen: { key: "qwen-fixture-last-9012" } }, qwenKeyTarget: { ...qwenKeyTarget, workspace: "new-workspace" } })).status).toBe(200);
    expect((await api("PUT", "/api/config", { live: { qwen: { key: "" } }, qwenKeyTarget: { ...qwenKeyTarget, workspace: "new-workspace" } })).status).toBe(200);
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

it("refuses stale Qwen credential saves and removals after another client changes the destination", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as { error?: string; live?: LiveSettings } };
  };
  const disk = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  const staleTarget = { region: "cn-beijing", workspace: "" };
  const currentTarget = { region: "ap-southeast-1", workspace: "other-workspace" };
  try {
    expect((await api("PATCH", "/api/live/settings", { provider: "qwen", qwenRegion: staleTarget.region, qwenWorkspace: staleTarget.workspace })).status).toBe(200);
    expect((await api("PATCH", "/api/live/settings", { qwenRegion: currentTarget.region, qwenWorkspace: currentTarget.workspace })).status).toBe(200);
    expect((await api("PUT", "/api/config", { live: { qwen: { key: "current-key-fixture", keyFor: "qwen:evil.invalid" } }, qwenKeyTarget: currentTarget })).status).toBe(200);
    expect(disk().live.qwen.keyFor).toBe("qwen:other-workspace.ap-southeast-1.maas.aliyuncs.com");
    const before = disk();
    for (const key of ["stale-key-fixture", ""]) {
      for (const qwenKeyTarget of [staleTarget, undefined]) {
        const refused = await api("PUT", "/api/config", { live: { qwen: { key } }, qwenKeyTarget });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toContain("Reload Call settings");
        expect(disk()).toEqual(before);
      }
    }
    const status = await api("GET", "/api/config");
    expect(status.body.live).toMatchObject({ qwenRegion: currentTarget.region, qwenWorkspace: currentTarget.workspace, qwenKeyConfigured: true });
    expect(JSON.stringify(status)).not.toContain("key-fixture");
    expect(JSON.stringify(status)).not.toContain("qwenKeyTarget");
    expect(disk()).not.toHaveProperty("qwenKeyTarget");
    expect(disk().live.qwen).not.toHaveProperty("qwenKeyTarget");
    expect((await api("PUT", "/api/config", { live: { qwen: { key: "" } }, qwenKeyTarget: currentTarget })).status).toBe(200);
    expect(disk().live.qwen.key).toBe("");
    console.info(JSON.stringify(fixture.info));
  } finally { await fixture.close(); }
}, 30_000);
