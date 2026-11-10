import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VaultStore } from "../vault-store.ts";
import { createSignInVaultChoices, fittingChoices, nameFit } from "./choices.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("which saved names could fit what a bot asked for", () => {
  it("counts the telling words two names share, never words like key or token alone", () => {
    expect(nameFit("Stripe secret key", "STRIPE_LIVE_KEY")).toBe(1);
    expect(nameFit("OpenAI API key", "openai-org-key")).toBe(1);
    expect(nameFit("API key", "GitHub API token")).toBe(0);
    expect(fittingChoices("Acme Stripe key", [{ name: "GitHub token" }, { name: "Stripe" }, { name: "Acme Stripe secret" }]).map((one) => one.name))
      .toEqual(["Acme Stripe secret", "Stripe"]);
  });
});

describe("Use a saved login on a sign-in card", () => {
  function fixture(open = true) {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-vault-choices-"));
    dirs.push(dataDir);
    const logins = new VaultStore({ dataDir });
    const settled: unknown[] = [];
    const choices = createSignInVaultChoices({
      logins, cardBots: (id) => [id, "mate"], openCard: () => (open ? { url: "https://accounts.example.com/login" } : null),
      settle: (...args) => { settled.push(args); return { status: 200, body: { done: true, resumed: true } }; },
    });
    const save = (site: string, username: string, bots: "all" | string[]) =>
      logins.create({ site, hosts: [site], exactHost: false, username, password: "fake-saved-pass", source: "settings", bots });
    return { logins, settled, choices, save };
  }

  it("offers the site's logins the bot may not use yet, by username; picking one lets it and its browser mates use it and answers the card", () => {
    const one = fixture();
    const kept = one.save("example.com", "ops@example.com", ["quill"]);
    one.save("example.com", "shared", "all");
    one.save("example.org", "elsewhere", ["quill"]);
    expect(one.choices.list("pepper", "t1", "m1")).toEqual({ status: 200, body: { choices: [{ id: kept.id, name: "ops@example.com" }] } });
    expect(one.choices.use("pepper", "t1", "m1", kept.id)).toEqual({ status: 200, body: { done: true, resumed: true } });
    expect(one.logins.list().find((login) => login.id === kept.id)!.bots).toEqual(["quill", "pepper", "mate"]);
    expect(one.settled).toEqual([["pepper", "t1", "m1", "done", { site: "example.com" }]]);
    expect(JSON.stringify(one.choices.list("pepper", "t1", "m1"))).not.toContain("fake-saved-pass");
  });

  it("offers nothing once the card is answered, and refuses a login it did not offer", () => {
    const one = fixture(false);
    const kept = one.save("example.com", "ops", ["quill"]);
    expect(one.choices.list("pepper", "t1", "m1").body).toEqual({ choices: [] });
    expect(one.choices.use("pepper", "t1", "m1", kept.id).status).toBe(404);
    expect(one.settled).toEqual([]);
    expect(one.logins.list()[0]!.bots).toEqual(["quill"]);
  });
});
