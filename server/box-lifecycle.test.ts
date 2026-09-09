import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("cloud computer lifecycle", () => {
  let api: Server;
  let sleepBox: typeof import("./box.ts").sleepBox;
  let execOnBox: typeof import("./box.ts").execOnBox;
  const requests: Array<{ method: string; path: string; command?: string }> = [];
  const botId = "browser-session-test";

  beforeAll(async () => {
    const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
    const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
    const machineName = `ogb-${prefix}-${hash}`;
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        requests.push({ method: req.method ?? "GET", path: url.pathname, command: parsed.command });
        res.writeHead(200, { "content-type": "application/json" });
        if (url.pathname === "/api/box/v1/boxes") {
          res.end(JSON.stringify({ boxes: [{ id: "bx_23456789", name: machineName, state: "ready" }] }));
        } else if (url.pathname === "/api/box/v1/boxes/bx_23456789" && req.method === "GET") {
          res.end(JSON.stringify({ ok: true, box: { id: "bx_23456789", name: machineName, state: "ready" } }));
        } else if (url.pathname.endsWith("/commands")) {
          res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    ({ execOnBox, sleepBox } = await import("./box.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("asks Chrome to exit before archiving the computer", async () => {
    await sleepBox({ box: { token: "box_test" } } as any, botId);

    const commandIndex = requests.findIndex((request) => request.path.endsWith("/commands"));
    const stopIndex = requests.findIndex((request) => request.path.endsWith("/stop"));
    expect(commandIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(commandIndex);
    expect(requests[commandIndex]?.command).toContain("kill -TERM");
    expect(requests[commandIndex]?.command).toContain("pgrep -o -x");
  });

  it("runs the owner console in the same clean environment as the bot tool", async () => {
    requests.length = 0;
    await execOnBox({ box: { token: "box_test" } } as any, botId, `printf '%s' "$BOX_TOKEN"`);

    const command = requests.find((request) => request.path.endsWith("/commands"))?.command ?? "";
    expect(command).toContain('exec env -i HOME="$HOME"');
    expect(command).toContain("/bin/bash -c");
  });

  it("rejects an oversized owner-console command before contacting the provider", async () => {
    requests.length = 0;
    await expect(
      execOnBox({ box: { token: "box_test" } } as any, botId, "x".repeat(4001)),
    ).rejects.toThrow("maximum 4000 characters");
    expect(requests).toHaveLength(0);
  });
});
