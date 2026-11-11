import { describe, expect, it } from "vitest";

import { createMoveLeases, LEASE_MS, moveLeaseRoute } from "./cloud-send-lease.ts";

function cloud(owner = true) {
  let clock = 1_000;
  const leases = createMoveLeases(() => clock);
  const ask = async (body: unknown, method = "POST") => {
    let answered: { status: number; body: any } | undefined;
    const handled = await moveLeaseRoute({ leases, owner: () => (owner ? { person: "p_owner", name: "Owner" } : null) }, {
      path: "/api/cloud-send/lease", method, req: { resume() {} } as never, res: { setHeader() {} } as never, auth: {} as never, url: new URL("http://x/"),
      json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; }, readBody: async () => body } as never);
    expect(handled).toBe(true);
    return answered!;
  };
  return { ask, leases, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("POST /api/cloud-send/lease", () => {
  it("lets one computer at a time move in: the other hears who moves now, and goes once that one lets go", async () => {
    const { ask } = cloud();
    expect(await ask({ v: 1, holder: "computer-mac", label: "Mac" })).toEqual({ status: 200, body: { v: 1, held: true, until: 1_000 + LEASE_MS } });
    expect(await ask({ v: 1, holder: "computer-nuc", label: "NUC" })).toEqual({ status: 409, body: { v: 1, held: false, label: "Mac", until: 1_000 + LEASE_MS } });
    expect((await ask({ v: 1, holder: "computer-mac", label: "" })).status, "the holder asks again as it goes on").toBe(200);
    expect((await ask({ v: 1, holder: "computer-nuc", label: "NUC" })).body.label, "and keeps its name").toBe("Mac");
    expect(await ask({ v: 1, holder: "computer-nuc", release: true })).toEqual({ status: 200, body: { v: 1, held: false } });
    expect((await ask({ v: 1, holder: "computer-nuc", label: "NUC" })).status, "only the holder lets go").toBe(409);
    await ask({ v: 1, holder: "computer-mac", release: true });
    expect((await ask({ v: 1, holder: "computer-nuc", label: "NUC" })).status).toBe(200);
  });

  it("runs out when its computer stops asking, as an app that quit does", async () => {
    const { ask, advance } = cloud();
    await ask({ v: 1, holder: "computer-mac", label: "Mac" });
    advance(LEASE_MS - 1);
    expect((await ask({ v: 1, holder: "computer-nuc", label: "NUC" })).status).toBe(409);
    advance(1);
    expect((await ask({ v: 1, holder: "computer-nuc", label: "NUC" })).status).toBe(200);
  });

  it("answers only My Cloud's owner, and only a well-formed ask", async () => {
    expect((await cloud(false).ask({ v: 1, holder: "computer-mac" })).status).toBe(403);
    const { ask } = cloud();
    expect((await ask({ v: 1, holder: "x" })).status).toBe(400);
    expect((await ask({ v: 1, holder: "computer-mac" }, "GET")).status).toBe(405);
  });
});
