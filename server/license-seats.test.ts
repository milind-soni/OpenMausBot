import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SignInAllowList } from "./account-signin.ts";
import { loadEnterpriseLayer } from "./enterprise.ts";
import { registerSeatSources, seatInviteRefusal, seatLimit, seatsInUse } from "./license-seats.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./routes/config.ts";
import { createSeatsRoutes } from "./routes/seats.ts";

const dirs: string[] = [];
afterEach(async () => {
  await loadEnterpriseLayer({ dir: join(tmpdir(), "omb-enterprise-absent"), licenseKey: undefined });
  registerSeatSources(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

/** A server whose enterprise layer accepts the licence with these claims; `files: false` is a desktop or a Cloud home. */
async function licensed(claims: { seats?: number; expiresAt?: string | null } = {}, options: { files?: boolean } = {}) {
  const layer = mkdtempSync(join(tmpdir(), "omb-seats-layer-"));
  const data = mkdtempSync(join(tmpdir(), "omb-seats-data-"));
  dirs.push(layer, data);
  mkdirSync(join(layer, "server"));
  const said = { customer: "Acme", features: ["budgets"], expiresAt: claims.expiresAt === undefined ? day(30) : claims.expiresAt, plan: "business-server", ...(claims.seats ? { seats: claims.seats } : {}) };
  writeFileSync(join(layer, "server", "index.js"), `export function register() { return ${JSON.stringify(said)}; }`);
  const key = "omb1.eyJjbGFpbXMiOnRydWV9.c2lnbmF0dXJl";
  if (options.files === false) await loadEnterpriseLayer({ dir: layer, licenseKey: key });
  else {
    writeFileSync(join(data, "license.key"), key);
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
  }
}

/** The server's sign-in list and sessions, counted by routes/seats.ts as the running server counts them. */
function people(admins: string[], members: string[], sessions: { email?: string; token?: boolean; scopes?: string[] }[] = []) {
  const list: SignInAllowList = { admins, members };
  createSeatsRoutes({ signInList: () => list, sessions: () => sessions as never });
  return list;
}

describe("seats on a licensed server install", () => {
  it("has no limit without a licence, without a seats claim, past the grace period, or where licence files are not read", async () => {
    people(["owner@acme.test"], ["a@acme.test", "b@acme.test"]);
    const more = { admins: ["owner@acme.test"], members: ["a@acme.test", "b@acme.test", "c@acme.test"] };
    expect(seatLimit()).toBeNull();
    expect(seatInviteRefusal(more)).toBeNull();
    await licensed({});
    expect(seatLimit()).toBeNull();
    expect(seatInviteRefusal(more)).toBeNull();
    await licensed({ seats: 2, expiresAt: day(-30) });
    expect(seatLimit()).toBeNull();
    expect(seatInviteRefusal(more)).toBeNull();
    await licensed({ seats: 2 }, { files: false });
    expect(seatLimit()).toBeNull();
    expect(seatInviteRefusal(more)).toBeNull();
  });

  it("lets people in up to the plan's seats and refuses the invite past them", async () => {
    await licensed({ seats: 3 });
    people(["owner@acme.test"], ["a@acme.test"]);
    expect(seatsInUse()).toBe(2);
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["a@acme.test", "b@acme.test"] })).toBeNull();
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["a@acme.test", "b@acme.test", "c@acme.test"] })).toEqual({ seats: 3, used: 2 });
    // An address already signed in through an @domain entry is a person already: listing it adds nobody.
    people(["owner@acme.test"], ["@acme.test"], [{ email: "a@acme.test" }, { email: "b@acme.test" }]);
    expect(seatsInUse()).toBe(3);
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["@acme.test", "a@acme.test"] })).toBeNull();
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["@acme.test", "d@acme.test"] })).toEqual({ seats: 3, used: 3 });
  });

  it("locks nobody out: over the limit, removing someone, changing a role and saving the list as it is all pass", async () => {
    await licensed({ seats: 2 });
    const list = people(["owner@acme.test"], ["a@acme.test", "b@acme.test", "c@acme.test"]);
    expect(seatsInUse()).toBe(4);
    expect(seatInviteRefusal(list)).toBeNull();
    expect(seatInviteRefusal({ admins: ["owner@acme.test", "a@acme.test"], members: ["b@acme.test", "c@acme.test"] })).toBeNull();
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["a@acme.test", "b@acme.test"] })).toBeNull();
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["a@acme.test", "b@acme.test", "d@acme.test"] })).toBeNull();
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["a@acme.test", "b@acme.test", "c@acme.test", "d@acme.test"] })).toEqual({ seats: 2, used: 4 });
  });

  it("keeps the last licence's seats during the grace period", async () => {
    await licensed({ seats: 2, expiresAt: day(-3) });
    people(["owner@acme.test"], ["a@acme.test"]);
    expect(seatLimit()).toBe(2);
    expect(seatInviteRefusal({ admins: ["owner@acme.test"], members: ["a@acme.test", "b@acme.test"] })).toEqual({ seats: 2, used: 2 });
  });

  it("answers an invite past the seats with a plain sentence and saves nothing", async () => {
    await licensed({ seats: 2 });
    people(["owner@acme.test"], ["a@acme.test"]);
    const replies: { status: number; body: unknown }[] = [];
    const route = createConfigRoutes({} as unknown as ConfigRouteDeps);
    const auth: RequestAuth = { kind: "session", session: { id: "owner", scopes: ["admin", "client"] } as never, via: "cookie", scopes: ["admin", "client"] };
    await route({
      req: { headers: {} }, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method: "PUT", auth,
      json: (_res: unknown, status: number, body: unknown) => { replies.push({ status, body }); },
      readBody: async () => ({ signIn: { admins: ["owner@acme.test"], members: ["a@acme.test", "new@acme.test"] } }),
    } as unknown as Parameters<typeof route>[0]);
    expect(replies).toEqual([{
      status: 409,
      body: {
        error: "This server's plan has 2 seats, and 2 people can already sign in. Add seats from your MausBot account, then invite again.",
        errorKey: "serverError.seats.full", errorParams: { seats: "2", used: "2" }, code: "seats_full",
      },
    }]);
  });
});
