import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createPersonBotOrder } from "./person-bot-order.ts";

const fleet = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (bots: ReadonlyArray<{ id: string }>) => bots.map((bot) => bot.id);

it("keeps each person's own order across a restart, and the team's for whoever has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-orders-"));
  const orders = createPersonBotOrder(dir);
  expect(ids(orders.reorder("p_ada", fleet("a", "b", "c"), ["c", "a"]))).toEqual(["c", "b", "a"]);
  expect(ids(createPersonBotOrder(dir).ordered("p_ada", fleet("a", "b", "c")))).toEqual(["c", "b", "a"]);
  expect(ids(orders.ordered("p_cleo", fleet("a", "b", "c")))).toEqual(["a", "b", "c"]);
  // The team's order changing moves nothing she ordered; a new bot takes its place in the team's.
  expect(ids(orders.ordered("p_ada", fleet("d", "b", "a", "c")))).toEqual(["d", "c", "b", "a"]);
  // A later reorder of a few starts from her own list.
  expect(ids(orders.reorder("p_ada", fleet("d", "b", "a", "c"), ["a", "b"]))).toEqual(["d", "c", "a", "b"]);
  orders.forgetPerson("p_ada");
  expect(ids(createPersonBotOrder(dir).ordered("p_ada", fleet("a", "b", "c")))).toEqual(["a", "b", "c"]);
});

it("sends a team order frame as each person's own list", () => {
  const orders = createPersonBotOrder(mkdtempSync(join(tmpdir(), "bot-orders-")));
  orders.reorder("p_ada", fleet("a", "b"), ["b", "a"]);
  expect(orders.ownOrderFrame("p_ada", { kind: "bots.order", botIds: ["a", "b", "c"] })).toEqual({ kind: "bots.order", botIds: ["b", "a", "c"] });
  expect(orders.ownOrderFrame("p_ada", { kind: "bots.order", botIds: ["b", "a"] }), "already hers").toBeNull();
  expect(orders.ownOrderFrame("p_cleo", { kind: "bots.order", botIds: ["a", "b"] })).toBeNull();
  expect(orders.ownOrderFrame("p_ada", { kind: "bot", bot: {} })).toBeNull();
});
