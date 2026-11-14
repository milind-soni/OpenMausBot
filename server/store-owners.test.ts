import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { botOwner, chiefScope, nameFromEmail } from "../shared/bot-owner.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { setCreatedBy, setReportsTo } from "./bot-owners.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const ADA = "ada@acme.test", BOB = "bob@acme.test";

describe("a Team Cloud bot's owner", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("is whoever it reports to, else whoever created it, else nobody", () => {
    expect(botOwner({ createdBy: " Ada@Acme.test " })).toBe(ADA);
    expect(botOwner({ createdBy: ADA, reportsTo: BOB })).toBe(BOB);
    expect(botOwner({})).toBeNull();
    expect(nameFromEmail("marie-claire.dupont@acme.test")).toBe("Marie Claire Dupont");
  });

  it("keeps one Chief per person on a team and one per department everywhere else", () => {
    expect(chiefScope({ section: "Work", createdBy: ADA })).toBe(`owner:${ADA}`);
    expect(chiefScope({ section: "Work" })).toBe("section:Work");
    const store = new Store(selection);
    const adas = store.createBot({ name: "Ada's Chief", createdBy: ADA });
    const bobs = store.createBot({ name: "Bob's Chief", createdBy: ADA, reportsTo: BOB });
    const another = store.createBot({ name: "Another", reportsTo: ADA });
    store.setChiefOfStaff(adas.id);
    store.setChiefOfStaff(bobs.id);
    // Two crowns in one department, one per person.
    expect(store.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.name).sort()).toEqual(["Ada's Chief", "Bob's Chief"]);
    // A second crown for Ada hands hers over, as a department's does.
    expect(store.setChiefOfStaff(another.id)?.map((bot) => bot.name).sort()).toEqual(["Ada's Chief", "Another"]);
    expect(store.bot(bobs.id)?.chiefOfStaff).toBe(true);
    // Reported to Ada, Bob's Chief would be her second: refused, and nothing changes.
    expect(setReportsTo(store, [bobs.id], ADA)).toEqual({ ok: false, reason: "chief-conflict" });
    expect(store.bot(bobs.id)?.reportsTo).toBe(BOB);
    // Moving departments never touches a person's Chief.
    expect(store.setBotsSection([another.id], "Product A").ok).toBe(true);
    expect(store.bot(another.id)?.chiefOfStaff).toBe(true);
    // Saved and read back the same way.
    const reloaded = new Store(selection);
    expect(reloaded.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.name).sort()).toEqual(["Another", "Bob's Chief"]);
    expect(reloaded.bot(bobs.id)).toMatchObject({ createdBy: ADA, reportsTo: BOB });
  });

  it("hands bots over and back to their creator, together", () => {
    const store = new Store(selection);
    const fox = store.createBot({ name: "Fox", section: "Product A", createdBy: ADA });
    const owl = store.createBot({ name: "Owl", section: "Product A", createdBy: ADA });
    const changed = setReportsTo(store, [fox.id, owl.id], " Bob@Acme.test ");
    expect(changed.ok).toBe(true);
    expect([store.bot(fox.id), store.bot(owl.id)].map((bot) => botOwner(bot!))).toEqual([BOB, BOB]);
    expect(setReportsTo(store, [fox.id], null).ok).toBe(true);
    expect(store.bot(fox.id)?.reportsTo).toBeUndefined();
    expect(new Store(selection).bot(fox.id)).not.toHaveProperty("reportsTo");
    expect(botOwner(store.bot(fox.id)!)).toBe(ADA);
    expect(setReportsTo(store, ["missing"], BOB)).toEqual({ ok: false, reason: "unavailable" });
    setCreatedBy(store, fox.id, BOB);
    expect(store.bot(fox.id)?.createdBy).toBe(ADA);
  });

  it("changes nothing for bots nobody owns: one Chief per department, as before", () => {
    const store = new Store(selection);
    const first = store.createBot({ section: "Work" });
    const second = store.createBot({ section: "Work" });
    store.setChiefOfStaff(first.id);
    expect(store.setChiefOfStaff(second.id)?.map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    const elsewhere = store.createBot({ section: "Home" });
    store.setChiefOfStaff(elsewhere.id);
    expect(store.setBotsSection([elsewhere.id], "Work")).toEqual({ ok: false, reason: "chief-conflict" });
  });
});
