import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("redacts endpoint capacity on Team Cloud GET, live and replay while retaining each person's own profile", async () => {
  const fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-endpoint-profile-${randomBytes(8).toString("hex")}`,
    team: { id: "team-endpoint-privacy", name: "Endpoint fixture" } });
  const team = fx.team!;
  const endpoint = "http://127.0.0.1:1/v1", canary = "http://endpoint-capacity-canary.invalid/private/v1";
  const streams: SseRecorder[] = [];
  try {
    const file = join(team.home, ".openmausbot", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...config, openaiCompat: { url: endpoint,
      contextWindows: { [endpoint]: { fixture: 8192 }, [canary]: { private: 65536 } } } }));
    await team.relaunch();
    const owner = (await team.pair({ email: "owner@endpoint.test", role: "owner" })).token!;
    const member = (await team.pair({ email: "member@endpoint.test", role: "member" })).token!;
    expect((await team.as(owner, "PUT", "/api/me", { name: "Owner fixture", aboutMe: "Owner notes" })).status).toBe(200);
    expect((await team.as(member, "PUT", "/api/me", { name: "Member fixture", aboutMe: "Member notes" })).status).toBe(200);
    const own = (await team.as(owner, "GET", "/api/config")).body;
    const members = (await team.as(member, "GET", "/api/config")).body;
    const assertMember = (body: any) => {
      expect(body.profile).toMatchObject({ name: "Member fixture", email: "member@endpoint.test", aboutMe: "Member notes" });
      expect(body.openaiCompat).toEqual({ configured: false, url: endpoint });
      expect(JSON.stringify(body)).not.toContain(canary);
      expect(body.openaiCompat).not.toHaveProperty("resolvedUrl");
      expect(body.openaiCompat).not.toHaveProperty("contextWindows");
    };
    const assertOwner = (body: any) => {
      expect(body.profile).toMatchObject({ name: "Owner fixture", email: "owner@endpoint.test", aboutMe: "Owner notes" });
      expect(body.openaiCompat).toMatchObject({ resolvedUrl: endpoint, contextWindows: { [canary]: { private: 65536 } } });
    };
    assertMember(members); assertOwner(own);
    const headers = (token: string) => ({ ...fx.edge, authorization: `Bearer ${token}` });
    const live = await openSse(`${team.base}/api/events`, headers(member)); streams.push(live);
    const adminLive = await openSse(`${team.base}/api/events`, headers(owner)); streams.push(adminLive);
    const hello = await live.until(frame => frame.kind === "hello");
    expect((await team.as(owner, "PUT", "/api/config", { language: "en" })).status).toBe(200);
    assertMember(await live.until(frame => frame.kind === "config"));
    assertOwner(await adminLive.until(frame => frame.kind === "config"));
    live.close(); adminLive.close();
    const replay = await openSse(`${team.base}/api/events?since=${encodeURIComponent(hello.cursor)}`, headers(member)); streams.push(replay);
    const adminReplay = await openSse(`${team.base}/api/events?since=${encodeURIComponent(hello.cursor)}`, headers(owner)); streams.push(adminReplay);
    expect(await replay.until(frame => frame.kind === "hello")).toMatchObject({ resumed: true });
    expect(await adminReplay.until(frame => frame.kind === "hello")).toMatchObject({ resumed: true });
    assertMember(await replay.until(frame => frame.kind === "config"));
    assertOwner(await adminReplay.until(frame => frame.kind === "config"));
  } finally { streams.forEach(stream => stream.close()); await fx.close(); }
}, hostTimeout(150_000));
