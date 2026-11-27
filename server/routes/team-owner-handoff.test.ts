import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createTeamPeople } from "../team-people.ts";
import { createTeamOwnerRoutes } from "./team-owners.ts";

const BOB = "bob@acme.test", ADA = "ada@acme.test";
const auth: RequestAuth = { kind: "session", scopes: ["client"], via: "bearer", session: {
  id: "bob-session", tokenHash: "0".repeat(64), label: "Bob's desktop", createdAt: 1, lastSeenAt: 1, expiresAt: 9_000,
  email: BOB, teamRole: "member", membershipAuthority: "team", scopes: ["client"],
} };

describe("a handoff while the previous owner's request body is held", () => {
  it.each(["missing", "hidden"] as const)("returns 404 for a %s bot without reading an invalid body", async (availability) => {
    const store = new Store(() => ({ instanceId: "claude", model: "sonnet" }));
    const bot = store.createBot({ name: "Scout", createdBy: BOB });
    const people = createTeamPeople(DATA_DIR);
    const route = createTeamOwnerRoutes({ team: { id: "acme", name: "Acme" } as never, people, store,
      sees: () => availability !== "hidden", publicBot: (record) => record });
    const path = `/api/bots/${availability === "missing" ? `${bot.id}-missing` : bot.id}/reports-to`;
    let answer: unknown;
    let reads = 0;
    await route({ req: {} as IncomingMessage, res: {} as ServerResponse,
      path, url: new URL(path, "http://localhost"), method: "PUT", auth,
      json: ((_res: ServerResponse, status: number, body: unknown) => { answer = { status, body }; }) as never,
      readBody: async () => { reads += 1; return {}; },
    });
    expect(answer).toEqual({ status: 404, body: { error: "no such bot" } });
    expect(reads).toBe(0);
    expect(store.bot(bot.id)?.reportsTo).toBeUndefined();
  });

  it.each([["owner", 403], ["visibility", 404], ["personal", 409]] as const)("rechecks the bot's current %s after reading the body", async (change, expectedStatus) => {
    const store = new Store(() => ({ instanceId: "claude", model: "sonnet" }));
    const bot = store.createBot({ name: "Scout", createdBy: BOB });
    const people = createTeamPeople(DATA_DIR);
    people.seen(BOB, "member");
    people.seen(ADA, "admin");
    let visible = true;
    let release!: (body: unknown) => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const body = new Promise<unknown>((resolve) => { release = resolve; });
    const route = createTeamOwnerRoutes({ team: { id: "acme", name: "Acme" } as never, people, store,
      sees: () => visible, publicBot: (record) => record });
    let status: number | undefined;
    const path = `/api/bots/${bot.id}/reports-to`;
    const pending = route({ req: {} as IncomingMessage, res: {} as ServerResponse,
      path, url: new URL(path, "http://localhost"), method: "PUT", auth,
      json: ((_res: ServerResponse, code: number) => { status = code; }) as never,
      readBody: async () => { reading(); return body; },
    });
    await started;
    if (change === "owner") store.patchBot(bot.id, { reportsTo: ADA });
    if (change === "visibility") visible = false;
    if (change === "personal") store.patchBot(bot.id, { defaultBot: { person: ADA } });
    release({ email: BOB });
    await pending;
    expect(status).toBe(expectedStatus);
    if (change === "owner") expect(store.bot(bot.id)?.reportsTo).toBe(ADA);
    else expect(store.bot(bot.id)?.reportsTo).toBeUndefined();
  });
});
