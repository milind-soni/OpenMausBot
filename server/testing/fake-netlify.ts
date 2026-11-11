#!/usr/bin/env node
// A stand-in for Netlify's deploy API on loopback: create a site, a file-digest deploy, file uploads, deploy state,
// making a site public, and the published site itself under /live/<site id>/.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

interface FakeDeploy {
  id: string;
  siteId: string;
  draft: boolean;
  files: Record<string, string>;
  required: Set<string>;
  state: "uploading" | "ready";
}

export interface FakeNetlify {
  url: string;
  /** Every request, in order: "METHOD /path". */
  requests: string[];
  /** Authorization headers that were not the expected token. */
  refused: string[];
  sites: Map<string, { name: string; live: Map<string, Buffer>; teamLogin: boolean }>;
  deploys: Map<string, FakeDeploy>;
  /** Paths whose bytes were uploaded, in order, across all deploys. */
  uploads: string[];
  failNext(status: number, body: unknown): void;
  /** What a site's root is served as; Netlify serves a lone file stored at "/" as text/plain. */
  rootContentType: string;
  stop(): Promise<void>;
}

/** `teamLogin`: new sites answer 401 until `sso_login` is turned off, as on a new Netlify account (2026-11). */
export async function startFakeNetlify(token: string, { teamLogin = false }: { teamLogin?: boolean } = {}): Promise<FakeNetlify> {
  const blobs = new Map<string, Buffer>();
  let failure: { status: number; body: unknown } | null = null;
  const fake: Omit<FakeNetlify, "url" | "stop"> = {
    requests: [], refused: [], sites: new Map(), deploys: new Map(), uploads: [],
    failNext: (status, body) => { failure = { status, body }; },
    rootContentType: "text/html; charset=UTF-8",
  };
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const deployView = (deploy: FakeDeploy) => ({
    id: deploy.id, site_id: deploy.siteId, state: deploy.state, required: [...deploy.required],
    ssl_url: `${origin()}/live/${deploy.siteId}/`, deploy_ssl_url: `${origin()}/live/${deploy.siteId}--${deploy.id}/`,
  });
  const settle = (deploy: FakeDeploy) => {
    if (deploy.required.size) return;
    deploy.state = "ready";
    const live = new Map(Object.entries(deploy.files).map(([path, sha]) => [path, blobs.get(sha)!]));
    if (deploy.draft) fake.sites.set(`${deploy.siteId}--${deploy.id}`, { name: "draft", live, teamLogin: false });
    else fake.sites.get(deploy.siteId)!.live = live;
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = decodeURIComponent(new URL(req.url ?? "/", origin()).pathname);
      fake.requests.push(`${req.method} ${path}`);
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };

      const page = /^\/live\/([\w-]+)(\/.*)$/.exec(path);
      if (page) {
        if (fake.sites.get(page[1]!.split("--")[0]!)?.teamLogin) {
          res.writeHead(401, { "content-type": "text/html" });
          return res.end("<title>Login Redirect</title><a href=\"https://app.netlify.com/edge-access\">Log in</a>");
        }
        const file = fake.sites.get(page[1]!)?.live.get(page[2] === "/" ? "/index.html" : page[2]!);
        const html = page[2] === "/" ? fake.rootContentType : page[2]!.endsWith(".html") ? "text/html; charset=UTF-8" : "application/octet-stream";
        res.writeHead(file ? 200 : 404, { "content-type": file ? html : "text/plain" });
        return res.end(file ?? "Not found");
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        fake.refused.push(req.headers.authorization ?? "");
        return send(401, { code: 401, message: "Access Denied" });
      }
      if (failure) {
        const { status, body: answer } = failure;
        failure = null;
        return send(status, answer);
      }

      if (req.method === "POST" && path === "/api/v1/sites") {
        const id = randomBytes(8).toString("hex");
        const name = (JSON.parse(body.toString() || "{}") as { name?: string }).name ?? `fake-${id}`;
        fake.sites.set(id, { name, live: new Map(), teamLogin });
        return send(201, { id, name, url: `${origin()}/live/${id}/`, ssl_url: `${origin()}/live/${id}/`, admin_url: `${origin()}/admin/${name}` });
      }
      const change = /^\/api\/v1\/sites\/([\w-]+)$/.exec(path);
      const changed = change && fake.sites.get(change[1]!);
      if (req.method === "PATCH" && changed) {
        if ((JSON.parse(body.toString()) as { sso_login?: boolean }).sso_login === false) changed.teamLogin = false;
        return send(200, { id: change[1], name: changed.name, sso_login: changed.teamLogin });
      }
      const create = /^\/api\/v1\/sites\/([\w-]+)\/deploys$/.exec(path);
      if (req.method === "POST" && create) {
        if (!fake.sites.has(create[1]!)) return send(404, { code: 404, message: "Not Found" });
        const input = JSON.parse(body.toString()) as { files: Record<string, string>; draft?: boolean };
        const deploy: FakeDeploy = {
          id: randomBytes(8).toString("hex"), siteId: create[1]!, draft: input.draft === true, files: input.files,
          required: new Set(Object.values(input.files).filter((sha) => !blobs.has(sha))), state: "uploading",
        };
        fake.deploys.set(deploy.id, deploy);
        settle(deploy);
        return send(200, deployView(deploy));
      }
      const status = /^\/api\/v1\/sites\/[\w-]+\/deploys\/([\w-]+)$/.exec(path);
      if (req.method === "GET" && status && fake.deploys.has(status[1]!)) return send(200, deployView(fake.deploys.get(status[1]!)!));
      const upload = /^\/api\/v1\/deploys\/([\w-]+)\/files(\/.+)$/.exec(path);
      const deploy = upload && fake.deploys.get(upload[1]!);
      if (req.method === "PUT" && upload && deploy) {
        const sha = createHash("sha1").update(body).digest("hex");
        if (deploy.files[upload[2]!] !== sha) return send(422, { code: 422, message: "The file does not match its digest" });
        blobs.set(sha, body);
        deploy.required.delete(sha);
        fake.uploads.push(upload[2]!);
        settle(deploy);
        return send(200, { path: upload[2], sha });
      }
      send(404, { code: 404, message: "Not Found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return Object.assign(fake, {
    url: `${origin()}/api/v1`,
    stop: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.FAKE_NETLIFY_TOKEN;
  if (!token) throw new Error("set FAKE_NETLIFY_TOKEN to the token the stand-in accepts");
  const fake = await startFakeNetlify(token, { teamLogin: process.env.FAKE_NETLIFY_TEAM_LOGIN === "1" });
  console.log(fake.url);
  process.on("SIGUSR2", () => console.log(JSON.stringify({ requests: fake.requests, uploads: fake.uploads, refused: fake.refused.length })));
}
