import { createServer, request, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openCredentialBroker, type CredentialBroker } from "./broker.ts";
import { GITHUB_TOKEN_REUSE_MS, brokeredLocation, gitRequest, githubGrant, type GithubGrantDeps } from "./broker-github.ts";

const TOKEN = "ghp_unitFakeToken0123456789abcdefABCDEF";
const basic = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
const pkt = (text: string) => `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")}${text}`;
const A = "1".repeat(40), B = "2".repeat(40);

describe("which requests the github grant takes", () => {
  it("only git's smart-HTTP requests to one repository", () => {
    expect(gitRequest("GET", "/acme/widgets.git/info/refs", "?service=git-upload-pack")).toEqual({ repo: "acme/widgets", service: "git-upload-pack", advertisement: true });
    expect(gitRequest("GET", "/Acme/Widgets/info/refs", "?service=git-receive-pack")).toEqual({ repo: "acme/widgets", service: "git-receive-pack", advertisement: true });
    expect(gitRequest("POST", "/acme/widgets.git/git-receive-pack", "")).toEqual({ repo: "acme/widgets", service: "git-receive-pack", advertisement: false });
    expect(gitRequest("POST", "/acme/w.x_y-z/git-upload-pack", "")).toMatchObject({ repo: "acme/w.x_y-z" });
  });

  it("nothing else: another page, another method, a dumb-HTTP read, a traversal or an encoded path", () => {
    for (const [method, path, query] of [
      ["GET", "/acme/widgets.git/info/refs", ""], ["GET", "/acme/widgets.git/info/refs", "?service=git-upload-archive"],
      ["POST", "/acme/widgets.git/info/refs", "?service=git-upload-pack"], ["GET", "/acme/widgets.git/git-upload-pack", ""],
      ["POST", "/acme/widgets.git/git-receive-pack", "?x=1"], ["GET", "/acme/widgets/issues", ""], ["GET", "/login", ""],
      ["GET", "/acme/widgets.git/HEAD", ""], ["GET", "/acme/widgets.git/objects/info/packs", ""],
      ["GET", "/acme/../evil/widgets.git/info/refs", "?service=git-upload-pack"], ["GET", "/../acme/w/info/refs", "?service=git-upload-pack"],
      ["GET", "/acme/..%2fevil/info/refs", "?service=git-upload-pack"], ["GET", "/acme/%2e%2e/info/refs", "?service=git-upload-pack"],
      ["GET", "/acme/../info/refs", "?service=git-upload-pack"], ["GET", "/acme/.git/info/refs", "?service=git-upload-pack"],
      ["GET", "//evil.example/acme/w/info/refs", "?service=git-upload-pack"], ["GET", "/-acme/w/info/refs", "?service=git-upload-pack"],
      ["GET", "/acme/w/x/info/refs", "?service=git-upload-pack"],
    ] as const) expect(gitRequest(method, path, query), `${method} ${path}${query}`).toBeNull();
  });

  it("points a Location on the upstream back through the broker and leaves any other alone", () => {
    expect(brokeredLocation("https://github.com/acme/new-name.git/info/refs?service=git-upload-pack", "https://github.com/", "/b/t/github")).toBe("/b/t/github/acme/new-name.git/info/refs?service=git-upload-pack");
    expect(brokeredLocation("https://evil.example/x", "https://github.com/", "/b/t/github")).toBe("https://evil.example/x");
    expect(brokeredLocation("https://github.com.evil.example/x", "https://github.com/", "/b/t/github")).toBe("https://github.com.evil.example/x");
  });
});

// The broker listens on a unix socket, which Windows refuses at a file path (EACCES): Linux and macOS.
const unixSocket = describe.skipIf(process.platform === "win32");

unixSocket("the github grant in the broker", () => {
  let dir: string, upstream: Server, broker: CredentialBroker, clock = 1_800_000_000_000;
  const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: Buffer }> = [];
  let answer: (url: string, res: ServerResponse, body: Buffer) => void = (_url, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  let onFirstChunk: (() => void) | null = null;

  afterEach(async () => {
    await broker?.close();
    await new Promise<void>((done) => upstream ? (upstream.closeAllConnections(), upstream.close(() => done())) : done());
    rmSync(dir, { recursive: true, force: true });
    seen.length = 0;
    answer = (_url, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    onFirstChunk = null;
  });

  async function start(deps: Partial<GithubGrantDeps> = {}): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "omb-gh-grant-"));
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => { if (!chunks.length) onFirstChunk?.(); chunks.push(chunk); });
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        answer(req.url ?? "", res, body);
      });
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", () => done()));
    broker = await openCredentialBroker({ socketPath: join(dir, "broker.sock"), now: () => clock });
    const grant = githubGrant({ audience: () => "owner", token: async () => TOKEN, reportAuthFailure: () => {}, now: () => clock, ...deps, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
    return broker.mintForProcess({ botId: "b1", threadId: "t1", grants: { github: grant } }).token;
  }

  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | string) =>
    new Promise<{ status: number; body: Buffer; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ socketPath: join(dir, "broker.sock"), path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
      });
      req.on("error", reject);
      req.end(body);
    });

  it("adds GitHub's Basic credential for the fixed upstream and drops every credential the client sent", async () => {
    const token = await start();
    const res = await call("GET", `/b/${token}/github/acme/widgets.git/info/refs?service=git-upload-pack`, {
      authorization: "Bearer bot-made-this-up", cookie: "user_session=stolen", "x-api-key": "k", "proxy-authorization": "Basic eA==", "git-protocol": "version=2",
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/acme/widgets.git/info/refs?service=git-upload-pack");
    expect(seen[0]!.headers.authorization).toBe(basic(TOKEN));
    expect(seen[0]!.headers["git-protocol"]).toBe("version=2");
    expect(seen[0]!.headers.host).toBe(`127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    for (const name of ["cookie", "x-api-key", "proxy-authorization"]) expect(seen[0]!.headers[name]).toBeUndefined();
  });

  it("refuses any other path before it reaches GitHub, and a token for another grant or none", async () => {
    const token = await start();
    for (const path of ["/acme/widgets/issues", "/acme/../evil/w.git/info/refs?service=git-upload-pack", "/acme/%2e%2e/info/refs?service=git-upload-pack", "/login", "//evil.example/a/b/info/refs?service=git-upload-pack"]) {
      const res = await call("GET", `/b/${token}/github${path}`);
      expect(res.status, path).toBe(403);
    }
    expect((await call("POST", `/b/${token}/github/acme/w/info/refs?service=git-upload-pack`)).status).toBe(403);
    expect((await call("GET", `/b/omb_t0_${"0".repeat(48)}/github/acme/w/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("streams both ways: the upstream has the first bytes before the client ends, and the client before the upstream ends", async () => {
    const token = await start();
    let release!: () => void;
    const upstreamGotData = new Promise<void>((done) => { onFirstChunk = done; });
    const req = request({ socketPath: join(dir, "broker.sock"), path: `/b/${token}/github/acme/w.git/git-upload-pack`, method: "POST", headers: { "content-type": "application/x-git-upload-pack-request" } });
    req.write(Buffer.alloc(64 * 1024, 1));
    await upstreamGotData;
    answer = (_url, res) => {
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      res.write("first");
      new Promise<void>((done) => { release = done; }).then(() => res.end("last"));
    };
    const firstOut = new Promise<string>((resolve) => req.on("response", (res) => res.once("data", (chunk: Buffer) => { resolve(chunk.toString()); res.resume(); })));
    req.end(Buffer.alloc(64 * 1024, 2));
    expect(await firstOut).toBe("first");
    release();
    expect(seen[0]!.body.length).toBe(128 * 1024);
  });

  it("tells the sign-in on GitHub's 401, not on a 403 or 404", async () => {
    const reported: Array<string | null> = [];
    const token = await start({ reportAuthFailure: (who) => reported.push(who) });
    for (const status of [403, 404]) {
      answer = (_url, res) => res.writeHead(status).end();
      expect((await call("GET", `/b/${token}/github/acme/w/info/refs?service=git-upload-pack`)).status).toBe(status);
    }
    expect(reported).toEqual([]);
    answer = (_url, res) => res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end();
    expect((await call("GET", `/b/${token}/github/acme/w/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect(reported).toEqual(["owner"]);
  });

  it("asks for the token on each request after a short while, and for the audience every time", async () => {
    let audience: string | null = "owner";
    const asked: Array<string | null> = [];
    const token = await start({ audience: () => audience, token: async (who) => { asked.push(who); return who === "owner" ? TOKEN : "ghp_other"; } });
    const get = () => call("GET", `/b/${token}/github/acme/w/info/refs?service=git-upload-pack`);
    await get();
    await get();
    expect(asked).toEqual(["owner"]);
    clock += GITHUB_TOKEN_REUSE_MS;
    await get();
    expect(asked).toEqual(["owner", "owner"]);
    audience = "p_member";
    await get();
    expect(seen.at(-1)!.headers.authorization).toBe(basic("ghp_other"));
    // A conversation that is nobody's own any more gets no credential at all.
    audience = null;
    await get();
    expect(seen.at(-1)!.headers.authorization).toBeUndefined();
    expect(asked).toEqual(["owner", "owner", "p_member"]);
  });

  it("points a renamed repository's redirect back through the broker", async () => {
    const token = await start();
    answer = (url, res) => res.writeHead(301, { location: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/acme/new.git${url.slice(url.indexOf("/info/refs"))}` }).end();
    const res = await call("GET", `/b/${token}/github/acme/old.git/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(`/b/${token}/github/acme/new.git/info/refs?service=git-upload-pack`);
  });

  describe("a push", () => {
    const advertise = (branch: string) => (url: string, res: ServerResponse, body: Buffer) => {
      if (url.includes("service=git-upload-pack")) {
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
        res.end(`001e# service=git-upload-pack\n0000${pkt(`${A} HEAD\u0000multi_ack symref=HEAD:refs/heads/${branch} agent=git/2\n`)}0000`);
        return;
      }
      res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" }).end(`forwarded ${body.length}`);
    };
    const push = (token: string, ref: string, extra: Buffer = Buffer.alloc(0), headers: Record<string, string> = {}) =>
      call("POST", `/b/${token}/github/acme/w.git/git-receive-pack`, { "content-type": "application/x-git-receive-pack-request", ...headers },
        Buffer.concat([Buffer.from(`${pkt(`${A} ${B} ${ref}\u0000 report-status-v2 side-band-64k`)}0000`, "latin1"), extra]));

    it("forwards a new branch's push byte for byte, with the pack behind its command list", async () => {
      const token = await start();
      answer = advertise("dev");
      const pack = Buffer.alloc(200 * 1024, 9);
      const res = await push(token, "refs/heads/bot/x", pack);
      const commands = Buffer.from(`${pkt(`${A} ${B} refs/heads/bot/x\u0000 report-status-v2 side-band-64k`)}0000`, "latin1");
      expect(res.body.toString()).toBe(`forwarded ${commands.length + pack.length}`);
      const sent = seen.find((request) => request.url === "/acme/w.git/git-receive-pack")!;
      expect(sent.body.equals(Buffer.concat([commands, pack]))).toBe(true);
      expect(sent.headers.authorization).toBe(basic(TOKEN));
    });

    it("refuses the default branch it learns from the upstream, which never sees that push, and asks once per repository", async () => {
      const token = await start();
      answer = advertise("dev");
      const refused = await push(token, "refs/heads/dev", Buffer.alloc(1024, 9));
      expect(refused.status).toBe(200);
      expect(refused.headers["content-type"]).toBe("application/x-git-receive-pack-result");
      expect(refused.body.toString("latin1")).toContain("ng refs/heads/dev the default branch is protected here; push to a new branch");
      expect(refused.body.toString("latin1")).toContain("Push your work to a new branch");
      expect((await push(token, "refs/heads/main")).body.toString()).toMatch(/^forwarded/);
      expect(seen.filter((request) => request.url.endsWith("/git-receive-pack"))).toHaveLength(1);
      expect(seen.filter((request) => request.url.includes("service=git-upload-pack"))).toHaveLength(1);
      expect(seen.find((request) => request.url.includes("service=git-upload-pack"))!.headers["git-protocol"]).toBeUndefined();
    });

    it("protects main and master when the default branch cannot be learned", async () => {
      const token = await start();
      answer = (url, res, body) => url.includes("service=git-upload-pack") ? res.writeHead(404).end() : res.writeHead(200).end(`forwarded ${body.length}`);
      for (const ref of ["refs/heads/main", "refs/heads/master"]) expect((await push(token, ref)).body.toString("latin1")).toContain(`ng ${ref} the default branch is protected here`);
      expect((await push(token, "refs/heads/trunk")).body.toString()).toMatch(/^forwarded/);
    });

    it("refuses a compressed or unreadable push without forwarding it", async () => {
      const token = await start();
      answer = advertise("main");
      const gz = await push(token, "refs/heads/bot/x", Buffer.alloc(0), { "content-encoding": "gzip" });
      expect(gz.body.toString("latin1")).toContain("unpack This push was sent compressed");
      const odd = await call("POST", `/b/${token}/github/acme/w.git/git-receive-pack`, {}, `${pkt("push-cert\u0000report-status")}0000`);
      expect(odd.body.toString("latin1")).toContain("unpack This push was refused: signed pushes are not taken here.");
      expect(seen.filter((request) => request.url.endsWith("/git-receive-pack"))).toEqual([]);
    });
  });
});
