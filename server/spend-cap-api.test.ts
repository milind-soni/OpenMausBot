// The monthly spend cap and sell prices through real turns: the isolated
// fake-engine fixture booted with a stand-in enterprise layer that grants
// `budgets` and `billing`, the shared control surface for sends and waits,
// and the cap read back from /api/usage. No real licence, engine, or
// provider is involved; the fixture's home is disposable.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("spend cap and prices through real turns", () => {
  let session: VerificationServer;
  let layerDir: string;

  beforeEach(async () => {
    // The folder shape core looks for: <dir>/server/index.js exporting register().
    layerDir = mkdtempSync(join(tmpdir(), "omb-fake-layer-"));
    mkdirSync(join(layerDir, "server"));
    writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["budgets", "billing"], expiresAt: "2099-01-01" }; }\n');
    session = await launchVerificationServer(process.env, undefined, undefined, undefined, { dir: layerDir, licenseKey: "fixture-key" });
  }, 60_000);

  afterEach(async () => {
    console.info(JSON.stringify(session.info));
    await session.close();
    await removeTempDir(layerDir);
  });

  const control = (args: string[]) => runControlOmb([...args, "--url", session.info.url]) as Promise<any>;
  const api = (path: string, init: RequestInit = {}) => fetch(`${session.info.url}${path}`, init);
  const put = (body: unknown) => api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = (botId: string, text: string) => api(`/api/bots/${encodeURIComponent(botId)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });

  it("refuses the next turn once the month reaches the cap, prices turns, and lets a raised cap through", async () => {
    const edition = (await (await api("/api/edition")).json()) as { edition: string; features: string[] };
    expect(edition).toMatchObject({ edition: "enterprise", features: ["billing", "budgets"] });

    // The fake engine reports $0.01 per turn: a $0.015 cap allows two turns and refuses the third.
    expect((await put({ budgets: { monthlyUsd: 0.015, warnAtPercent: 50 }, billing: { currency: "USD", prices: { default: { inputPerMillion: 1000, outputPerMillion: 2000 } } } })).status).toBe(200);
    const created = await control(["new-bot", "--name", "Cap probe"]);
    const botId = created.bot.id as string;

    for (const text of ["first", "second"]) {
      expect((await send(botId, text)).status).toBeLessThan(300);
      expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
    }
    const refused = await send(botId, "third");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "spend_cap", error: expect.stringContaining("$0.015") });

    const usage = (await (await api("/api/usage?groupBy=bot")).json()) as any;
    expect(usage.budget).toMatchObject({ monthlyUsd: 0.015, exceeded: true, warn: true });
    expect(usage.budget.spentUsd).toBeCloseTo(0.02, 6);
    expect(usage.billing).toEqual({ currency: "USD" });
    expect(usage.groups).toHaveLength(1);
    expect(usage.groups[0].turns).toBe(2);
    // priced from the list: tokens × the default rates, twice
    const perTurn = (usage.total.input / 2) * 1000 / 1_000_000 + (usage.total.output / 2) * 2000 / 1_000_000;
    expect(usage.total.billableUsd).toBeCloseTo(perTurn * 2, 9);
    expect(usage.groups[0].billableUsd).toBeCloseTo(perTurn * 2, 9);
    const csv = await (await api("/api/usage.csv")).text();
    expect(csv.split("\n")[0]).toContain("billable_usd");

    // A chat-only device sees the same refusal, not a silent drop.
    expect((await put({ budgets: { monthlyUsd: 1 } })).status).toBe(200);
    expect((await send(botId, "fourth")).status).toBeLessThan(300);
    expect(JSON.stringify(await control(["wait", "--bot", botId, "--timeout", "30"]))).toContain("settled");
    const raised = (await (await api("/api/usage")).json()) as any;
    expect(raised.budget).toMatchObject({ monthlyUsd: 1, exceeded: false });
    expect(raised.total.turns).toBe(3);
  }, 150_000);
});
