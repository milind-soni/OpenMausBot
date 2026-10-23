// /api/move/freeze: the desktop app freezes this computer's copy at the move's quiet moment (POST), lifts it when the
// move can't finish or My Cloud ended (DELETE; `{ automations: "off" }` when another computer is home now), and asks who
// is still busy (GET); POST /api/move/forget deletes the frozen copy once the move is long done. Every other change a
// frozen server refuses here, before any other route.
import { z } from "zod";

import type { MoveFreeze } from "../move-freeze.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface MoveFreezeRouteDeps {
  freeze: MoveFreeze;
  /** Who is still answering, queued, or in a card or sign-in: a bot's or room's name, "" when it has none; null when
   * nothing is. */
  busy(): string | null;
  /** Starts this server again, as a restored workspace does. */
  restart(): void;
  /** Switches off every automation here (move-freeze.ts `switchAutomationsOff`). */
  automationsOff?(): Promise<unknown>;
}

const freezeBody = z.object({ cloud: z.string().url().max(300).optional() });
const thawBody = z.object({ automations: z.literal("off").optional() });

export function createMoveFreezeRoutes({ freeze, busy, restart, automationsOff }: MoveFreezeRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/move/forget") {
      if (auth.kind !== "loopback") return json(res, 403, { error: "Only OpenMausBot on this computer can do this." });
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!freeze.forget()) return json(res, 409, { error: "Only a computer whose bots moved to My Cloud deletes its copy." });
      json(res, 200, { forgot: true });
      restart();
      return;
    }
    if (path === "/api/move/freeze") {
      if (auth.kind !== "loopback") return json(res, 403, { error: "Only OpenMausBot on this computer can do this." });
      if (method === "GET") {
        const who = busy();
        const cloud = freeze.cloud();
        return json(res, 200, { frozen: freeze.frozen(), ...(freeze.frozen() && cloud ? { cloud } : {}), ...(who === null ? {} : { busy: who }) });
      }
      if (method === "POST") {
        const body = freezeBody.safeParse(await readBody(req, 4096));
        if (!body.success) return json(res, 400, { error: "send { cloud }: My Cloud's address" });
        if (!freeze.frozen()) {
          const who = busy();
          if (who !== null) return json(res, 409, { error: "A bot is still working.", busy: who });
          freeze.freeze(body.data.cloud ?? null);
        }
        return json(res, 200, { frozen: true });
      }
      if (method === "DELETE") {
        const body = thawBody.safeParse(await readBody(req, 4096));
        if (!body.success) return json(res, 400, { error: 'send {}, or { automations: "off" } to lift it with every automation off' });
        if (!freeze.lifts()) return json(res, 409, { error: freeze.refusal() });
        if (body.data.automations === "off") {
          if (!automationsOff) return json(res, 409, { error: "This server can't switch its automations off." });
          await automationsOff();
        }
        return freeze.unfreeze() ? json(res, 200, { frozen: false }) : json(res, 409, { error: freeze.refusal() });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    const refused = freeze.refuses(method, path);
    return refused ? json(res, 409, { error: refused, code: "moved" }) : PASS;
  };
}
