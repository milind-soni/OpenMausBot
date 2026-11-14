// A phone without admin rights opens a bot's Data read-only (the mobile app's Data screen): the sheet, a page of rows and
// a chart card's picture. Tried as a Team Cloud member, whose session is the same client scope a `pair --phone` phone gets:
// a bot they can't see answers exactly as a missing one, and nothing that runs, changes or exports data opens to them.
import { randomBytes } from "node:crypto";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { DATA_ROUTES } from "../shared/data-surface.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const NO_SUCH_BOT = { status: 404, body: { error: "no such bot" } };

it("lets a member's phone read a visible bot's Data, and nothing of a bot they can't see", async () => {
  const fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-${randomBytes(8).toString("hex")}`, team: { id: "team-phone-data", name: "Acme" } });
  try {
    const team = fx.team!;
    // The fixture's native tree holds a fake 1Password SDK only; DuckDB loads on first use, so it can join it now.
    for (const scope of ["@duckdb", "@resvg"]) symlinkSync(fileURLToPath(new URL(`../node_modules/${scope}`, import.meta.url)), join(team.home, "native", "node_modules", scope), "junction");
    const owner = (await team.pair({ email: "olive@acme.test", role: "owner" })).token!;
    const member = (await team.pair({ email: "rui@acme.test", role: "member" })).token!;
    expect((await team.as(member, "GET", "/api/auth/session")).body.scopes).toEqual(["client"]);
    const made = async (name: string, visibility: string) => {
      const created = await team.as(owner, "POST", "/api/bots", { name, visibility });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const bot = created.body.bot as { id: string; threadId: string };
      // What the bot's own data tools do in a turn: a table, and a chart card of it on the sheet.
      const token = await team.capability(bot.id, bot.threadId, "data");
      const call = async (name: string, args: Record<string, unknown>) => {
        const answer = await fetch(`${team.base}/api/internal/data/mcp`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ method: "tools/call", params: { name, arguments: args } }),
        });
        const text = await answer.text();
        expect(answer.status, text).toBe(200);
        const { result } = JSON.parse(text) as { result: { isError?: boolean; structuredContent: Record<string, any>; content?: Array<{ text: string }> } };
        expect(result.isError, result.content?.[0]?.text).not.toBe(true);
        return result.structuredContent;
      };
      await call("data_sql", { sql: "CREATE TABLE orders AS SELECT * FROM (VALUES ('north', 3), ('south', 5), ('west', 8)) t(region, amount)" });
      const chart = await call("data_show", { kind: "chart", title: "By region", table: "orders", chart: { type: "bar", x: "region", y: "amount" } });
      return { id: bot.id, card: chart.id as string };
    };
    const shared = await made("Ledger", "everyone");
    const hidden = await made("Vault", "admins");

    const sheet = await team.as(member, "GET", DATA_ROUTES.sheet(shared.id));
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    expect(sheet.body.tables.map((table: { name: string }) => table.name)).toEqual(["orders"]);
    expect(sheet.body.sheet.cards.map((card: { id: string; kind: string }) => [card.id, card.kind])).toEqual([[shared.card, "chart"]]);
    // The page body the phone sends (BotData.kt), for a table and for a card's result.
    const page = await team.as(member, "POST", DATA_ROUTES.page(shared.id), { table: "orders", offset: 0, limit: 100 });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body).toMatchObject({ rowCount: 3, offset: 0 });
    expect(page.body.columns.map((column: { name: string }) => column.name)).toEqual(["region", "amount"]);
    expect((await team.as(member, "POST", DATA_ROUTES.page(shared.id), { cardId: shared.card, offset: 0, limit: 100 })).body.rowCount).toBe(3);
    const image = await fetch(`${team.base}${DATA_ROUTES.image(shared.id, shared.card)}?format=png&theme=dark&width=360&scale=2.0`, { headers: { ...fx.edge, authorization: `Bearer ${member}` } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");

    // A bot they can't see is a bot that isn't there, on every Data route.
    for (const id of [hidden.id, "missing-bot"]) {
      expect(await team.as(member, "GET", DATA_ROUTES.sheet(id)), id).toEqual(NO_SUCH_BOT);
      expect(await team.as(member, "POST", DATA_ROUTES.page(id), { table: "orders", offset: 0, limit: 100 }), id).toEqual(NO_SUCH_BOT);
      expect(await team.as(member, "GET", DATA_ROUTES.image(id, hidden.card)), id).toEqual(NO_SUCH_BOT);
    }
    expect((await team.as(owner, "GET", DATA_ROUTES.sheet(hidden.id))).status).toBe(200);

    // Running SQL, cancelling, changing a card and exporting stay an admin's.
    for (const [method, path, body] of [
      ["POST", DATA_ROUTES.run(shared.id), { sql: "SELECT 1" }],
      ["POST", DATA_ROUTES.cancel(shared.id), { cardId: shared.card }],
      ["PATCH", DATA_ROUTES.card(shared.id, shared.card), { pinned: true }],
      ["DELETE", DATA_ROUTES.card(shared.id, shared.card), undefined],
      ["POST", DATA_ROUTES.export(shared.id), { cardId: shared.card, format: "csv" }],
      ["GET", DATA_ROUTES.stats(shared.id, "orders"), undefined],
    ] as const) expect((await team.as(member, method, path, body)).status, `${method} ${path}`).toBe(403);
    const after = await team.as(owner, "GET", DATA_ROUTES.sheet(shared.id));
    expect(after.body.sheet.cards.map((card: { id: string; pinned?: boolean }) => [card.id, card.pinned ?? false])).toEqual([[shared.card, false]]);
  } finally {
    await fx.close();
  }
}, hostTimeout(180_000));
