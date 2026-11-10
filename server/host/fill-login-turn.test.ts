import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { BotLogins } from "../bot-logins.ts";
import { VaultStore } from "../vault-store.ts";
import type { OnePasswordLogins } from "../onepassword.ts";

import type { Surface } from "../../shared/wire.ts";
import type { BotRecord } from "../store.ts";
import { createFillLoginTurn, type FillLoginTurnDeps } from "./fill-login-turn.ts";

const turn = { botId: "b1", threadId: "t1", generation: "g1" };
const bot = { id: "b1", name: "Statements", browser: true, browserProfile: "bank" } as unknown as BotRecord;
const BANK = { site: "bank.test", hosts: ["bank.test"], exactHost: false, username: "person@example.test" };

function harness(over: Partial<FillLoginTurnDeps> & { at?: Surface | null } = {}) {
  const moveToBrowser = vi.fn(over.moveToBrowser ?? (() => true));
  const target = vi.fn(over.target ?? (async () => null));
  const deps: FillLoginTurnDeps = {
    place: () => (over.at === undefined ? "local" : over.at),
    current: (b) => b,
    builtInBrowserOn: () => true,
    browserSelectable: () => true,
    myChrome: () => false,
    claim: () => true,
    withSecretInput: (_session, _spec, fill) => fill(),
    logins: { sitesFor: () => [BANK], candidates: async () => [], markUsed: () => {} },
    onePasswordTrouble: () => undefined,
    loginInput: () => ({ engine: async () => null, insertText: async () => {}, press: async () => {}, click: async () => {} }),
    remember: () => {},
    stepContext: () => ({ botId: "b1", botName: "Statements", threadId: "t1", generation: "g1", turnId: () => null, record: false }),
    ...over,
    moveToBrowser,
    target,
  };
  return { fill: createFillLoginTurn(deps).fillLoginForTurn, moveToBrowser, target };
}

describe("fill_login outside the bot's own browser", () => {
  it.each(["local", "vm", "cloud"] as const)("moves a request on %s to the bot's browser and tells the bot to end the turn", async (at) => {
    const { fill, moveToBrowser, target } = harness({ at });
    const answer = await fill(bot, turn, undefined, undefined);
    expect(moveToBrowser).toHaveBeenCalledWith(turn);
    expect(target).not.toHaveBeenCalled();
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("never types one on the screen of");
    expect(answer.text).toContain("moving this conversation to your own browser");
    expect(answer.text).toContain("End this turn now");
    expect(answer.text).not.toContain("request_sign_in");
  });

  it("names the person's own Chrome when the bot's profile is My Chrome", async () => {
    const { fill } = harness({ myChrome: () => true });
    expect((await fill(bot, turn, undefined, undefined)).text).toContain("the person's own Chrome (My Chrome)");
  });

  it("asks for a sign-in on the screen when this run cannot move, without moving it", async () => {
    const { fill, moveToBrowser } = harness({ moveToBrowser: () => false });
    const answer = await fill(bot, turn, undefined, undefined);
    expect(moveToBrowser).toHaveBeenCalledOnce();
    expect(answer.text).toContain("this run cannot move to your browser");
    expect(answer.text).toContain("Call request_sign_in so the person signs in on this computer.");
  });

  it("never moves when the bot has no login to fill, and says 1Password could not be read", async () => {
    const { fill, moveToBrowser } = harness({
      logins: { sitesFor: () => [], candidates: async () => [], markUsed: () => {} },
      onePasswordTrouble: () => "Could not reach 1Password. Check the internet connection and try again.",
    });
    const answer = await fill(bot, turn, undefined, undefined);
    expect(moveToBrowser).not.toHaveBeenCalled();
    expect(answer.text).toBe("You have no saved logins to fill (1Password could not be read just now: Could not reach 1Password. Check the internet connection and try again.). Call request_sign_in so the person signs in on this computer.");
  });

  it("never moves when the bot's browser cannot be its place, and says why", async () => {
    const off = harness({ browserSelectable: () => false, builtInBrowserOn: () => false });
    const answer = await off.fill(bot, turn, undefined, undefined);
    expect(off.moveToBrowser).not.toHaveBeenCalled();
    expect(answer.text).toContain("the built-in browser is off for you here");
    const missing = harness({ browserSelectable: () => false });
    expect((await missing.fill(bot, turn, undefined, undefined)).text).toContain("it is not installed yet, or this AI model cannot use browser tools");
    expect(missing.moveToBrowser).not.toHaveBeenCalled();
  });

  it("keeps the plain answer for a conversation with no place at all", async () => {
    const { fill } = harness({ at: null, browserSelectable: () => false });
    expect(await fill(bot, turn, undefined, undefined)).toEqual({ ok: false, text: "fill_login works in the built-in browser, and this conversation has none. Call request_sign_in instead." });
  });
});

describe("fill_login in the bot's own browser", () => {
  it("fills there and never asks to move", async () => {
    const { fill, moveToBrowser, target } = harness({ at: "browser" });
    const answer = await fill(bot, turn, undefined, undefined);
    expect(moveToBrowser).not.toHaveBeenCalled();
    expect(target).toHaveBeenCalledOnce();
    expect(answer).toEqual({ ok: false, text: "The browser is not available on this computer right now. Call request_sign_in instead." });
  });

  it("says 1Password could not be read when no login matches the page", async () => {
    const { fill } = harness({
      at: "browser",
      target: async () => ({ session: "bot-b1", spec: { command: "agent-browser", env: {} }, env: {} }),
      loginInput: () => ({ engine: async () => ({ url: "https://bank.test/sign-in" }), insertText: async () => {}, press: async () => {}, click: async () => {} }),
      onePasswordTrouble: () => "1Password is limiting requests right now. Try again in a few minutes.",
    });
    const answer = await fill(bot, turn, undefined, undefined);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("No saved login for bank.test.");
    expect(answer.text).toContain("1Password could not be read just now, so its logins may be missing: 1Password is limiting requests right now.");
  });
});

describe("fill_login and a login kept to some bots on a shared browser", () => {
  const onePassword = { id: "1password", label: "1Password", fresh: async () => {}, items: () => [], read: async () => ({}), markUsed: () => {} } as unknown as OnePasswordLogins;
  const logins = (bots: ReadonlyArray<{ id: string; browserProfile?: string }>) => {
    const store = new VaultStore({ dataDir: mkdtempSync(join(tmpdir(), "omb-fill-shared-")) });
    store.create({ ...BANK, password: "never-shown", source: "settings", bots: ["b1"] });
    return new BotLogins(store, onePassword, () => bots);
  };

  it("has nothing to fill for a bot whose named profile another bot shares, and asks for a sign-in instead", async () => {
    const { fill, moveToBrowser } = harness({ logins: logins([{ id: "b1", browserProfile: "bank" }, { id: "b2", browserProfile: "bank" }]) });
    const answer = await fill(bot, turn, undefined, undefined);
    expect(moveToBrowser).not.toHaveBeenCalled();
    expect(answer.text).toBe("You have no saved logins to fill. Call request_sign_in so the person signs in on this computer.");
  });

  it("goes on to fill when the bot is alone on the profile", async () => {
    const { fill, moveToBrowser } = harness({ logins: logins([{ id: "b1", browserProfile: "bank" }, { id: "b2" }]) });
    await fill(bot, turn, undefined, undefined);
    expect(moveToBrowser).toHaveBeenCalledWith(turn);
  });
});

