import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";

it("persists shared user context and includes it in preview, direct and group turns", async () => {
  const fixture = await launchVerificationServer();
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async <T = { profile: { name: string; email: string; aboutMe: string } }>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(status);
    return response.json() as Promise<T>;
  };
  // Read only the synthetic engine's system text, never its environment.
  const sentSystem = () => (JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt: string }).systemPrompt;
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Profile fixture" }, 201);
    await api("/api/config", "PUT", { profile: { name: "Fixture user", email: "fixture@example.invalid" } });
    const aboutMe = "I prefer concise answers. My work week begins on Tuesday.";
    const saved = await api("/api/config", "PUT", { profile: { aboutMe } });
    expect(saved.profile).toMatchObject({ name: "Fixture user", email: "fixture@example.invalid", aboutMe });
    expect((await api("/api/config")).profile.aboutMe).toBe(aboutMe);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).profile.aboutMe).toBe(aboutMe);
    expect(JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`))).toContain(aboutMe);
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "Hello.");
    expect(await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).toContain(aboutMe);

    const created = await control("new-channel", "--name", "Profile room", "--members", bot.id) as { channel: { id: string } };
    await control("send-channel", "--channel", created.channel.id, "--text", "Hello team.");
    expect(await control("wait", "--channel", created.channel.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).toContain(aboutMe);

    await api("/api/config", "PUT", { profile: { name: "Renamed fixture" } });
    expect((await api("/api/config")).profile.aboutMe).toBe(aboutMe);
    await api("/api/config", "PUT", { profile: { aboutMe: "x".repeat(24_001) } }, 400);
    expect((await api("/api/config")).profile.aboutMe).toBe(aboutMe);
    await api("/api/config", "PUT", { profile: { aboutMe: "" } });
    expect(JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`))).not.toContain(aboutMe);
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "Hello again.");
    expect(await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).not.toContain(aboutMe);
    expect((await api("/api/config")).profile.name).toBe("Renamed fixture");
  } finally {
    await fixture.close();
  }
}, 90_000);
