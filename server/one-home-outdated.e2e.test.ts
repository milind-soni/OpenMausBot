// The one-time move to a Cloud still on an image too old to take one: this computer's server and a Cloud home
// (scripts/testing/cloud-send-fixture.ts) with main's own wiring between them, My Cloud's environment answering as an
// older Cloud's does until it updates. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CloudSendNotice } from "../electron/cloud-send.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fx: CloudSendFixture;
beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-outdated-${randomBytes(8).toString("hex")}` });
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

const journal = () => { try { return JSON.parse(readFileSync(fx.journalFile, "utf8")) as Record<string, any>; } catch { return null; } };

it("with My Cloud on an older image, the line says My Cloud is updating, never that the move fails; once it has updated, the move goes", async () => {
  expect((await fx.local("POST", "/api/bots", { name: "Juno" })).status).toBeLessThan(300);
  fx.intercept = (url) => (url.endsWith("/.well-known/openmausbot/environment")
    ? new Response(JSON.stringify({ capabilities: {} }), { status: 200, headers: { "content-type": "application/json" } }) : null);
  fx.account.state = { ...fx.account.state, machine: { status: "ready", origin: fx.cloudBase, moves: true } };
  await fx.oneHome.kick();
  expect(journal()).toMatchObject({ phase: "copy", updating: true });
  expect(journal()!.failingSince).toBeUndefined();
  for (const page of ["local", "cloud"] as const) {
    expect((await fx.call<CloudSendNotice>("cloud-send:notice", page)).move).toEqual({ phase: "copy", updating: true });
  }
  expect(fx.oneHome.away()).toBe(false);

  fx.intercept = null;
  const after = await fx.call<CloudSendNotice>("cloud-send:move-retry", "local");
  expect(journal()?.phase).toBe("done");
  expect(journal()!.updating).toBeUndefined();
  expect(after.move).toMatchObject({ phase: "done" });
}, hostTimeout(300_000));
