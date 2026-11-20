import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readAdminActivityRange } from "./admin-activity.ts";

it("records tool permission changes through the bot settings API", async () => {
  const fixture = await launchVerificationServer();
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Permission audit fixture", "--url", fixture.info.url]) as { bot: { id: string } };
    expect((await fetch(`${fixture.info.url}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ label: "Audit sharing fixture", scopes: ["client"] }) })).status).toBe(200);
    const patch = async (body: unknown) => fetch(`${fixture.info.url}/api/bots/${bot.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(body),
    });
    expect((await patch({ toolScope: { allow: ["native:read"] }, connectorScopes: { apps: { gmail: "read" } }, connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } } })).status).toBe(200);
    const rows = () => readAdminActivityRange(fixture.info.dataDir, { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) }).filter(row => row.changed?.includes("toolScope"));
    await expect.poll(() => rows().length).toBe(1);
    expect(rows()[0]!.changed).toEqual(expect.arrayContaining(["toolScope", "connectorScopes", "connectorTools"]));
    expect((await patch({ title: "Unrelated display edit" })).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect((await patch({ toolScope: null, connectorScopes: null, connectorTools: null })).status).toBe(200);
    await expect.poll(() => rows().length).toBe(2);
  } finally { await fixture.close(); }
}, 60_000);
