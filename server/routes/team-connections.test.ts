import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import type { TeamConnectionsHost } from "../host/team-connections-host.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PeopleConnections } from "../team-connections.ts";
import { createTeamConnectionRoutes, type TeamConnectionRouteDeps } from "./team-connections.ts";

const URL_A = "https://mail.example.com/mcp";
const URL_B = "https://other.example.com/mcp";
const EMAIL = "ada@acme.test";
const PERSON = personKey({ id: "", email: EMAIL });
const KEY = "Bearer personal-key-12345";

function setup() {
  const cfg = { mcpServers: { mail: { type: "http", url: URL_A, headers: { Authorization: "" } } } } as unknown as AppConfig;
  const people = new PeopleConnections({ dataDir: join(DATA_DIR, randomUUID()), brokerUrl: () => null, clients: () => undefined, isOwnerLive: () => true });
  const route = createTeamConnectionRoutes({
    cfg: () => cfg,
    host: { team: { id: "team-acme-1", name: "Acme" }, people, personMcp: () => ["mail"] } as TeamConnectionsHost,
    composio: {} as TeamConnectionRouteDeps["composio"], publicOrigin: null,
  });
  const auth: RequestAuth = { kind: "session", via: "bearer", scopes: ["client"], session: {
    id: "s-ada", tokenHash: "0".repeat(64), label: "Desktop", scopes: ["client"], createdAt: 1, lastSeenAt: 1, expiresAt: 9_000,
    email: EMAIL, teamRole: "member", membershipAuthority: "team",
  } };
  const save = async (body: Record<string, unknown>, duringBodyRead = () => {}) => {
    const answers: Array<{ status: number; body: unknown }> = [];
    const path = "/api/team/my-connections/mcp/mail/key";
    await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://localhost${path}`), path, method: "PUT", auth,
      json: (_res, status, answer) => { answers.push({ status, body: answer }); },
      readBody: async () => { duringBodyRead(); return body; },
    });
    return answers[0]!;
  };
  return { cfg, people, save };
}

it.each(["before request", "during body read"])("rejects a personal key when the URL changes %s", async (when) => {
  const { cfg, people, save } = setup();
  people.putKey(PERSON, EMAIL, "mail", { url: URL_A, header: "Authorization", value: "Bearer kept-key-67890" });
  const changeUrl = () => { cfg.mcpServers = { mail: { type: "http", url: URL_B, headers: { Authorization: "" } } }; };
  if (when === "before request") changeUrl();
  const answer = await save({ value: KEY, url: URL_A }, when === "during body read" ? changeUrl : undefined);

  expect(answer.status).toBe(409);
  expect(answer.body).toMatchObject({ error: expect.stringMatching(/address changed/i) });
  expect(people.key(PERSON, "mail", URL_B)).toBeNull();
  expect(people.key(PERSON, "mail", URL_A)?.value).toBe("Bearer kept-key-67890");
});

it("saves a personal key for the matching URL", async () => {
  const { people, save } = setup();
  expect(await save({ value: KEY, url: URL_A })).toEqual({ status: 200, body: { ok: true } });
  expect(people.key(PERSON, "mail", URL_A)).toEqual({ url: URL_A, header: "Authorization", value: KEY });
  expect(people.key(PERSON, "mail", URL_B)).toBeNull();
});

it("pins a key sent without a URL to the current address, as members only see the host", async () => {
  const { people, save } = setup();
  expect(await save({ value: KEY })).toEqual({ status: 200, body: { ok: true } });
  expect(people.key(PERSON, "mail", URL_A)).toEqual({ url: URL_A, header: "Authorization", value: KEY });
});

it.each(["", 123])("refuses a malformed expected URL (%s)", async (url) => {
  const { people, save } = setup();
  expect((await save({ value: KEY, url })).status).toBe(400);
  expect(people.key(PERSON, "mail", URL_A)).toBeNull();
});
