import "../testing/scrub-ambient-omb-env.ts";

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { pairingRequest, SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-token-"));
let server: Server;
let origin: string;
let registry: SessionRegistry;
/** A server from before access tokens: it ignores tokenTtlMs. */
let oldServer = false;
const DAY = 24 * 3_600_000;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    if (req.method === "POST" && req.url === "/api/auth/pairing") {
      const request = pairingRequest(body);
      if ("error" in request) return send(400, request);
      const { tokenTtlMs: _ignored, ...plain } = request;
      return send(200, registry.openPairing(oldServer ? plain : request));
    }
    if (req.method === "POST" && req.url === "/api/auth/pair") {
      const paired = registry.exchange({ code: body.code, label: body.label ?? "", source: "test" });
      return paired.ok ? send(200, paired) : send(paired.status, { error: paired.error });
    }
    if (req.method === "GET" && req.url === "/api/auth/sessions") return send(200, { sessions: registry.list() });
    const revoking = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(req.url ?? "");
    if (req.method === "DELETE" && revoking) return registry.revoke(revoking[1]!) ? send(200, { ok: true }) : send(404, { error: "no such session" });
    send(404, { error: "no route" });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  oldServer = false;
  registry = new SessionRegistry({ file: join(mkdtempSync(join(dir, "data-")), "sessions.json") });
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  await removeTempDir(dir);
});

const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
  const code = await runHeadless([...argv, "--url", origin], { io, env: {} });
  return { code, out, err };
};

describe("token", () => {
  it("makes a client token that ends on its date, saves it to a private file, and never prints it", async () => {
    const file = join(dir, "ci-token");
    const made = await run(["token", "create", "Nightly CI", "--expires", "90d", "--out", file, "--json"]);
    expect(made.code).toBe(0);
    const token = readFileSync(file, "utf8").trim();
    expect(token).toMatch(/^omb_sess_/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(made)).not.toContain(token);
    const result = JSON.parse(made.out[0]!);
    expect(result).toMatchObject({ ok: true, tokenFile: file, token: { name: "Nightly CI", scope: "client" } });
    expect(result.token.expiresAt - Date.now()).toBeGreaterThan(90 * DAY - 60_000);
    expect(registry.authenticate(token)).toMatchObject({ scopes: ["client"], token: true });
  });

  it("lists tokens only, and revokes one by id but never a device's session", async () => {
    const device = registry.exchange({ code: registry.openPairing({ label: "Phone" }).code, label: "", source: "x" });
    if (!device.ok) throw new Error(device.error);
    expect((await run(["token", "create", "Deploys", "--scope", "admin", "--out", join(dir, "deploy-token")])).code).toBe(0);
    const listed = await run(["token", "list", "--json"]);
    const tokens = JSON.parse(listed.out[0]!).tokens;
    expect(tokens).toEqual([expect.objectContaining({ name: "Deploys", scope: "admin" })]);
    const refused = await run(["token", "revoke", device.session.id]);
    expect(refused.code).toBe(1);
    expect(refused.err[1]).toContain("openmausbot sessions revoke");
    expect(registry.list()).toHaveLength(2);
    expect((await run(["token", "revoke", tokens[0].id])).code).toBe(0);
    expect(registry.list().map((session) => session.label)).toEqual(["Phone"]);
  });

  it("refuses before minting anything: an existing file, a bad scope or term, and no name", async () => {
    const file = join(dir, "taken");
    writeFileSync(file, "old\n");
    for (const argv of [["Taken", "--out", file], ["CI", "--out", join(dir, "a"), "--scope", "root"], ["CI", "--out", join(dir, "b"), "--expires", "30m"],
      ["--out", join(dir, "c")], ["CI"]]) {
      expect((await run(["token", "create", ...argv])).code, argv.join(" ")).toBe(2);
    }
    expect(readFileSync(file, "utf8")).toBe("old\n");
    expect(registry.list()).toEqual([]);
  });

  it("ends the session an older server opened instead, and says the server cannot make tokens (5)", async () => {
    oldServer = true;
    const file = join(dir, "old-token");
    const made = await run(["token", "create", "CI", "--out", file]);
    expect(made.code).toBe(5);
    expect(made.err[0]).toBe("error: this OpenMausBot server cannot make access tokens");
    expect(registry.list()).toEqual([]);
    expect(() => readFileSync(file)).toThrow();
  });

  it("passes on the server's own limit on a token's term", async () => {
    const made = await run(["token", "create", "CI", "--expires", "3000d", "--out", join(dir, "long-token")]);
    expect(made.code).toBe(1);
    expect(made.err[0]).toContain("OMB_SESSION_MAX_DAYS");
  });
});
