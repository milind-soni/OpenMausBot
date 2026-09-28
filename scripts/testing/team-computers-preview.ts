// Real OMB server and renderer; only the paid Boat provider is an owned local
// HTTP stand-in. No guest commands execute and no real credentials are read.
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { launchUi } from "./control-omb-ui.ts";

export async function launchTeamComputersPreview() {
  const boats: Array<{ id: string; name: string; state: string }> = [];
  const calls: Array<{ method: string; path: string }> = [];
  const idempotency = new Map<string, string>();
  let refuseCreate = false;
  const provider = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const send = (body: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : {};
      if (path === "/__fixture") {
        if (method === "POST") refuseCreate = body.refuseCreate === true;
        return send({ calls, boats, refuseCreate });
      }
      if (request.headers.authorization !== "Bearer box_verification_fixture") return send({ message: "fixture authentication failed" }, 401);
      calls.push({ method, path });
      // The provider list endpoint still answers with its historical "boxes" key.
      if (method === "GET" && path === "/boxes") return send({ ok: true, boxes: boats });
      if (method === "POST" && path === "/boxes") {
        if (refuseCreate) return send({ message: "Fixture account is rate-limited. Retry this computer." }, 429);
        const key = String(request.headers["idempotency-key"] ?? "");
        if (!key || body.noEnv !== true) return send({ message: "fixture requires isolated idempotent creation" }, 400);
        const previous = idempotency.get(key);
        if (previous) return send({ ok: true, box: boats.find((boat) => boat.id === previous) });
        const id = `bx_2345678${"9abcdefghjkmnpqrstuvwxyz"[boats.length]}`;
        const boat = { id, name: "fixture-pending", state: "idle" };
        boats.push(boat); idempotency.set(key, id);
        return send({ ok: true, box: boat }, 201);
      }
      const match = path.match(/^\/boxes\/(bx_[23456789abcdefghjkmnpqrstuvwxyz]{8})(?:\/(commands|desktop|stop|resume))?$/);
      const boat = boats.find((candidate) => candidate.id === match?.[1]);
      if (!match || !boat) return send({ message: "fixture resource not found" }, 404);
      if (method === "GET" && !match[2]) return send({ ok: true, box: boat });
      if (method === "PATCH" && !match[2]) { boat.name = body.name; return send({ ok: true, box: boat }); }
      if (method === "POST" && match[2] === "commands") return send({ ok: true, exitCode: 0, stdout: "", stderr: "" });
      if (method === "POST" && match[2] === "desktop") return send({ ok: true, desktopUrl: `https://desktop.invalid/${boat.id}` });
      if (method === "POST" && (match[2] === "stop" || match[2] === "resume")) {
        boat.state = match[2] === "stop" ? "archived" : "idle";
        return send({ ok: true, box: boat });
      }
      // Unexpected deletion is deliberately refused and remains in receipts.
      return send({ message: "fixture does not implement this mutation" }, 405);
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Boat fixture has no loopback port");
  const boatFixtureApi = `http://127.0.0.1:${address.port}`;
  const stdout = new Writable({ write(chunk, _encoding, done) {
    const info = JSON.parse(String(chunk));
    process.stdout.write(`${JSON.stringify({ ...info, boatFixtureApi }, null, 2)}\n`, done);
  } });
  try {
    await launchUi([], process.env, { stdout, stderr: process.stderr }, { boatFixtureApi });
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((done, reject) => provider.close((error) => error ? reject(error) : done()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launchTeamComputersPreview();
}
