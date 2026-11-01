import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it } from "vitest";

import { VisibleSet } from "../bot-visibility.ts";
import { json } from "../harness/http.ts";
import type { BotRecord } from "../store.ts";
import { createGroupRoutes } from "./groups.ts";
import type { RouteContext } from "./table.ts";

it("does not add a bot hidden while the channel creation body was read", async () => {
  let bot = { id: "b1", name: "Bot", threadId: "t1", visibility: "everyone" } as BotRecord;
  let created = false;
  let visible = new VisibleSet([bot], [], { kind: "member" });
  let read!: () => void;
  const reading = new Promise<void>((resolve) => { read = resolve; });
  let send!: (body: { memberIds: string[] }) => void;
  const body = new Promise<{ memberIds: string[] }>((resolve) => { send = resolve; });
  const route = createGroupRoutes({
    store: { bot: (id: string) => id === bot.id ? bot : undefined } as never,
    cloudHome: false, visibleFor: () => visible, actorKey: () => "alice", threadStarters: { set: () => {} },
    createChannel: () => { created = true; return { id: "g1", threadId: "room", memberIds: ["b1"] } as never; },
    publicGroupState: (group) => group as never,
  });
  let response: { status: number; body: unknown } | undefined;
  const result = route({
    req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL("http://localhost/api/groups"), path: "/api/groups", method: "POST",
    auth: { kind: "loopback", scopes: ["admin", "client"] },
    json: ((_res, status, body) => { response = { status, body }; }) as typeof json,
    readBody: (async () => { read(); return body; }) as RouteContext["readBody"],
  });
  await reading;
  bot = { ...bot, visibility: "admins" };
  visible = new VisibleSet([bot], [], { kind: "member" });
  send({ memberIds: ["b1"] });
  await result;
  expect(response).toEqual({ status: 400, body: { error: "unknown channel member: b1" } });
  expect(created).toBe(false);
});
