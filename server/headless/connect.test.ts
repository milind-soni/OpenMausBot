import "../testing/scrub-ambient-omb-env.ts";

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { writeTokenFile } from "./connect.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-connect-"));
let server: Server;
let origin: string;
const requests: Array<{ path: string; body: any }> = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined });
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/.well-known/openmausbot/environment") return send(200, { environmentId: "env-1", label: "Sandbox", version: "0.1.109" });
    if (req.url === "/api/auth/pairing") return send(200, { code: "ABCD-EFGH-JKLM" });
    if (req.url === "/api/auth/pair") {
      const body = JSON.parse(raw);
      return body.code === "ABCD-EFGH-JKLM"
        ? send(200, { token: "omb_sess_secret_token_value", session: { id: "s1", label: body.label, scopes: ["admin", "client"], expiresAt: Date.UTC(2026, 11, 1) } })
        : send(401, { error: "invalid or expired pairing code" });
    }
    send(404, {});
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  await removeTempDir(dir);
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
  return { io, out, err };
};

describe("connect", () => {
  it("mints a code on this computer's own server, saves the token to a private file, and never prints it", async () => {
    const file = join(dir, "token");
    const { io, out, err } = capture();
    expect(await runHeadless(["connect", origin, "--out", file, "--label", "CI runner", "--json"], { io, env: {} })).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("omb_sess_secret_token_value\n");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const result = JSON.parse(out[0]!);
    expect(result).toMatchObject({ ok: true, tokenFile: file, workspace: { label: "Sandbox", environmentId: "env-1" }, session: { label: "CI runner", scopes: ["admin", "client"] } });
    expect(JSON.stringify([out, err])).not.toContain("omb_sess_secret_token_value");
    expect(requests.map((request) => request.path)).toEqual(["/.well-known/openmausbot/environment", "/api/auth/pairing", "/api/auth/pair"]);
    expect(requests[1]!.body).toEqual({ label: "CI runner" });
  });

  it("uses a given code, refuses to overwrite a token file unless --force, and reports a refused code", async () => {
    const file = join(dir, "token-2");
    writeFileSync(file, "old\n");
    const refused = capture();
    expect(await runHeadless(["connect", origin, "--code", "abcd efgh jklm", "--out", file], { io: refused.io, env: {} })).toBe(2);
    expect(refused.err[0]).toContain("already exists");
    expect(await runHeadless(["connect", origin, "--code", "abcd efgh jklm", "--out", file, "--force"], { io: capture().io, env: {} })).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("omb_sess_secret_token_value\n");
    // the file it replaced was readable by others; the token in it is not
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const wrong = capture();
    expect(await runHeadless(["connect", origin, "--code", "ZZZZ-ZZZZ-ZZZZ", "--out", join(dir, "token-3")], { io: wrong.io, env: {} })).toBe(5);
    expect(wrong.err[0]).toBe("error: the code was not accepted: invalid or expired pairing code");
    const notACode = capture();
    expect(await runHeadless(["connect", origin, "--code", "12345678", "--out", join(dir, "token-4")], { io: notACode.io, env: {} })).toBe(2);
    expect(notACode.err[0]).toContain("sign-in code from an email");
  });

  it("needs a code for a workspace elsewhere, and never writes a token to the terminal", async () => {
    const remote = capture();
    expect(await runHeadless(["connect", "https://maus.example.com", "--out", join(dir, "t")], { io: remote.io, env: {} })).toBe(2);
    expect(remote.err[0]).toBe("error: a workspace elsewhere needs a pairing code");
    expect(remote.err.join("\n")).toContain("npx openmausbot pair");
    expect(() => writeTokenFile("-", "x", false)).toThrow("never to the terminal");
    expect(() => writeTokenFile("/dev/stdout", "x", true)).toThrow("never to the terminal");
  });
  it("takes the pairing link the server printed, and a private address over plain http", async () => {
    const file = join(dir, "token-link");
    const { io } = capture();
    expect(await runHeadless(["connect", `${origin}/pair#code=ABCD-EFGH-JKLM`, "--out", file], { io, env: {} })).toBe(0);
    expect(requests.at(-1)).toMatchObject({ path: "/api/auth/pair", body: { code: "ABCD-EFGH-JKLM" } });
    const lan = capture();
    expect(await runHeadless(["connect", "http://omb-test-no-such-host:1", "--code", "ABCD-EFGH-JKLM", "--out", join(dir, "token-lan")], { io: lan.io, env: {} })).toBe(5);
    expect(lan.err[0]).toContain("no MausBot server answers at http://omb-test-no-such-host:1");
    const open = capture();
    expect(await runHeadless(["connect", "http://203.0.113.9:8799", "--code", "ABCD-EFGH-JKLM", "--out", join(dir, "token-open")], { io: open.io, env: {} })).toBe(2);
    expect(open.err.join("\n")).toContain("put HTTPS in front");
    const bare = capture();
    expect(await runHeadless(["connect", "ABCD-EFGH-JKLM", "--out", join(dir, "token-bare")], { io: bare.io, env: {} })).toBe(2);
    expect(bare.err[0]).toContain("give the server's address too");
  });

});
