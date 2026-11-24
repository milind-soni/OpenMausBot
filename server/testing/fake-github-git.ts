// Test fixture: a stand-in for github.com's git over HTTPS, serving bare repositories with git's own `http-backend`
// (smart HTTP, both upload-pack and receive-pack), behind a Basic credential check like GitHub's. Plain HTTP on the
// loopback; the broker's github grant is pointed at it in code (server/bot-box/broker-github.ts GithubGrantDeps.upstream).
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export interface FakeGithub {
  url: string;
  seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }>;
  close(): Promise<void>;
}

/** Where git's http-backend is, or null when this git has none. */
export function httpBackend(): string | null {
  const found = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (found.status !== 0) return null;
  const file = join(found.stdout.trim(), "git-http-backend");
  return spawnSync(file, [], { env: { PATH: process.env.PATH ?? "", REQUEST_METHOD: "GET", PATH_INFO: "/" }, encoding: "utf8" }).error ? null : file;
}

/** Serves every bare repository under `root` at /<owner>/<repo>.git, answering 401 to any request without `basic`. */
export function openFakeGithub(input: { root: string; backend: string; basic: string }): Promise<FakeGithub> {
  const seen: FakeGithub["seen"] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (req.headers.authorization !== input.basic) {
      req.resume();
      res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"', "content-type": "text/plain" }).end("Invalid username or token.\n");
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const child = spawn(input.backend, [], {
      env: {
        PATH: process.env.PATH ?? "", GIT_PROJECT_ROOT: input.root, GIT_HTTP_EXPORT_ALL: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        REQUEST_METHOD: req.method ?? "GET", PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""), REMOTE_USER: "x-access-token", REMOTE_ADDR: "127.0.0.1",
        ...(req.headers["content-length"] ? { CONTENT_LENGTH: String(req.headers["content-length"]) } : {}),
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
        ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(child.stdin);
    child.stdin.on("error", () => {});
    let head = Buffer.alloc(0), started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const text = head.toString("latin1");
      const end = text.search(/\r?\n\r?\n/);
      if (end < 0) return;
      const gap = /\r?\n\r?\n/.exec(text.slice(end))![0].length;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of text.slice(0, end).split(/\r?\n/)) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
        if (name === "status") status = Number.parseInt(value, 10);
        else if (name) headers[name] = value;
      }
      started = true;
      res.writeHead(status, headers);
      res.write(head.subarray(end + gap));
    });
    child.stdout.on("end", () => { if (!started) res.writeHead(502); res.end(); });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
      });
    });
  });
}
