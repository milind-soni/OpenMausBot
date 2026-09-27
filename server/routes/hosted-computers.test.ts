import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { createHostedComputerRoutes } from "./hosted-computers.ts";
import { json, readBody } from "../harness/http.ts";
import type { HostedComputerManager } from "../hosted-computers/manager.ts";
import type { RequestAuth } from "../request-auth.ts";

it("rejects forged targets, revoked turn capabilities and a provider switch during body parsing", async () => {
  let valid = true;
  let expireOnBody = false;
  let switchOnBody = false;
  let bot = { id: "bot-a", computer: "cloud", cloudBackend: "orgo" };
  const execute = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
  const start = vi.fn(async () => ({ state: "running" }));
  const route = createHostedComputerRoutes({
    manager: { execute, start } as unknown as HostedComputerManager,
    bot: () => bot, access: () => "account-a-bot-a", enabled: () => true,
    busy: () => false, claim: () => () => {},
    authorizeTool: header => valid && header === "Bearer turn-capability" ? { provider: "orgo", key: "account-a-bot-a" } : null,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    await route({ req, res, path: url.pathname, url, method: req.method!, auth: {} as RequestAuth, json,
      readBody: async request => {
        const body = await readBody(request);
        if (expireOnBody) valid = false;
        if (switchOnBody) bot = { ...bot, cloudBackend: "daytona" };
        return body;
      } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, body: unknown, token = "turn-capability") => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  try {
    const path = "/api/internal/hosted-computer/execute";
    expect((await request(path, { command: "id" }, "forged")).status).toBe(403);
    expect((await request(path, { command: "id", key: "account-b", provider: "daytona" })).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect((await request(path, { command: "id" })).status).toBe(200);
    expect(execute).toHaveBeenCalledWith("orgo", "account-a-bot-a", "id", expect.any(Function));
    expireOnBody = true;
    expect((await request(path, { command: "id" })).status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(1);
    switchOnBody = true;
    expect((await request("/api/bots/bot-a/computer/provision", {})).status).toBe(409);
    expect(start).not.toHaveBeenCalled();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
