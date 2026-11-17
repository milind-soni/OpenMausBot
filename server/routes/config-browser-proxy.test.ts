import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

describe("Team Cloud browser proxy configuration", () => {
  it("refuses an admin's proxy change before writing shared config", async () => {
    const replies: Array<{ status: number; body: unknown }> = [];
    const route = createConfigRoutes({ cloudTeam: true } as unknown as ConfigRouteDeps);
    const auth: RequestAuth = {
      kind: "session",
      session: { id: "admin", scopes: ["admin", "client"], teamRole: "admin" } as never,
      via: "bearer",
      scopes: ["admin", "client"],
    };

    await route({
      req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method: "PATCH", auth,
      json: (_res: unknown, status: number, body: unknown) => { replies.push({ status, body }); },
      readBody: async () => ({ browserEngine: { egress: { proxy: "socks5://127.0.0.1:1080" } } }),
    } as unknown as Parameters<typeof route>[0]);

    expect(replies).toEqual([{ status: 403, body: { error: "Only the Team Cloud owner can configure the browser proxy." } }]);
  });
});
