#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join, relative, resolve, sep } from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const NETLIFY_API = "https://api.netlify.com/api/v1";
export const SITE_FILE = ".netlify-site.json";
const USER_AGENT = "OpenMausBot publish-to-netlify skill";
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOADS_AT_ONCE = 4;
const UPLOAD_TRIES = 3;
/** Netlify ends an API request after 30 seconds, so a large digest is prepared in the background ("async": true). */
const ASYNC_FROM_FILES = 1000;

const SECRET_NAMES = [
  /^env(\.(local|development|production|staging|test))?$/i,
  /\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(credentials|secrets?|service-account)(\..+)?\.(json|ya?ml|toml|txt)$/i,
  /^(npmrc|netrc|htpasswd)$/i,
];
const SKIPPED_FOLDERS = new Set(["node_modules", "__MACOSX"]);
const SKIPPED_FILES = new Set(["Thumbs.db"]);

/** Whether a file at this path, relative to the published folder, may be uploaded. Dotfiles and dot folders never are
 * (so `.openmausbot-secrets`, `.env`, `.git` and the site record stay home), except `.well-known`, which sites need. */
export function publishable(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  const name = parts.at(-1);
  for (const part of parts) {
    if (part.startsWith(".") && part !== ".well-known") return false;
    if (SKIPPED_FOLDERS.has(part)) return false;
  }
  if (SKIPPED_FILES.has(name)) return false;
  // Netlify (deploy API, 2026-11): a file path may not hold "#" or "?".
  if (/[#?]/.test(path)) return false;
  return !SECRET_NAMES.some((pattern) => pattern.test(name));
}

/** Every publishable plain file under `dir`, sorted, with the ones left out. Links are never followed. */
export function collectFiles(dir) {
  const files = [];
  const skipped = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      const path = relative(dir, full).split(sep).join("/");
      const info = lstatSync(full);
      if (!publishable(path) || info.isSymbolicLink()) {
        skipped.push(path);
      } else if (info.isDirectory()) {
        walk(full);
      } else if (info.isFile()) {
        files.push({ path, full, size: info.size });
      }
    }
  };
  walk(dir);
  return { files, skipped };
}

/** Netlify's file digest: "/path" to the SHA1 of its bytes, and each SHA1 to one path that has it. */
export function buildDigest(files, read = (file) => readFileSync(file.full)) {
  const digest = {};
  const bySha = new Map();
  for (const file of files) {
    const sha = createHash("sha1").update(read(file)).digest("hex");
    digest[`/${file.path}`] = sha;
    if (!bySha.has(sha)) bySha.set(sha, file);
  }
  return { digest, bySha };
}

export function uploadPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Only a loopback stand-in may replace Netlify's address, so a token can never be pointed at another host. */
export function apiBase(env) {
  const override = env.OMB_NETLIFY_API_URL;
  return override && /^http:\/\/127\.0\.0\.1:\d{1,5}(\/[\w/.-]*)?$/.test(override) ? override.replace(/\/$/, "") : NETLIFY_API;
}

export function proxyFor(url, env) {
  if (url.protocol !== "https:") return null;
  const none = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (none.some((entry) => entry === "*" || host === entry.replace(/^\./, "") || host.endsWith(`.${entry.replace(/^\./, "")}`))) return null;
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!proxy) return null;
  try {
    const parsed = new URL(proxy);
    return parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

/** A raw socket to host:port through an HTTP CONNECT proxy. */
export function openTunnel(proxy, host, port) {
  return new Promise((done, fail) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const connect = http.request({ host: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: `${host}:${port}`, headers, timeout: REQUEST_TIMEOUT_MS });
    connect.once("connect", (response, socket) => {
      if (response.statusCode === 200) return done(socket);
      socket.destroy();
      fail(new Error(`the proxy refused the connection to ${host} (${response.statusCode})`));
    });
    connect.once("timeout", () => connect.destroy(new Error(`the proxy did not answer for ${host}`)));
    connect.once("error", fail);
    connect.end();
  });
}

async function request(target, { method = "GET", headers = {}, body } = {}, env = process.env) {
  const url = new URL(target);
  const proxy = proxyFor(url, env);
  const options = { method, headers: { "User-Agent": USER_AGENT, ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) }, timeout: REQUEST_TIMEOUT_MS, agent: false };
  if (proxy) {
    const tunnel = await openTunnel(proxy, url.hostname, Number(url.port) || 443);
    options.createConnection = () => tls.connect({ socket: tunnel, servername: url.hostname });
  }
  return new Promise((done, fail) => {
    const call = (url.protocol === "https:" ? https : http).request(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => done({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", fail);
    });
    call.once("timeout", () => call.destroy(new Error(`${url.hostname} did not answer in ${REQUEST_TIMEOUT_MS / 1000} seconds`)));
    call.once("error", fail);
    call.end(body);
  });
}

class NetlifyError extends Error {
  constructor(step, response) {
    let answer = response.text.slice(0, 600);
    try {
      const parsed = JSON.parse(response.text);
      answer = parsed.message || (parsed.errors ? JSON.stringify(parsed.errors) : answer);
    } catch {
    }
    const reset = response.status === 429 && response.headers["x-ratelimit-reset"] ? ` (limit resets at ${new Date(Number(response.headers["x-ratelimit-reset"]) * 1000).toISOString()})` : "";
    super(`${step}: Netlify answered ${response.status}${answer ? `: ${answer}` : ""}${reset}`);
    this.status = response.status;
  }
}

function parseArgs(argv) {
  const args = { draft: false, public: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (flag === "--draft") args.draft = true;
    else if (flag === "--make-public") args.public = true;
    else if (["--dir", "--token-file", "--project", "--name"].includes(flag) && argv[at + 1]) args[flag.slice(2)] = argv[(at += 1)];
    else throw new Error(`unknown or incomplete option ${flag}`);
  }
  if (!args["token-file"] || !(args.dir || args.public)) throw new Error("usage: node deploy.mjs --dir <folder to publish> --token-file <secret file> [--project <folder>] [--name <site name>] [--draft] [--make-public]");
  return args;
}

function readSiteRecord(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(text);
  if (typeof record?.siteId !== "string" || !/^[\w-]{1,80}$/.test(record.siteId)) throw new Error(`${file} has no valid siteId; fix or delete it`);
  return record;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Netlify (2026-11): a new account's sites answer 401 with a redirect to its team login until `sso_login` is turned
 * off on the site, so a 401 is a deployed site that only the account's team can open. */
async function checkLink(url, env, deadline, pollMs) {
  for (;;) {
    const { status, type } = await request(url, {}, env).then((response) => ({ status: response.status, type: String(response.headers["content-type"] ?? "") }), () => ({ status: 0, type: "" }));
    if (status === 200) return { live: /^text\/html\b/i.test(type), access: "public", liveStatus: status, contentType: type };
    if (Date.now() >= deadline) return { live: false, access: status === 401 ? "private" : "unknown", liveStatus: status };
    await wait(pollMs);
  }
}

export async function publish(argv, env = process.env, { pollMs = 2000, waitMs = 120_000, privateWaitMs = 6000 } = {}) {
  const args = parseArgs(argv);
  const dir = args.dir ? realpathSync(resolve(args.dir)) : null;
  const project = resolve(args.project ?? ".");
  const tokenFile = realpathSync(resolve(args["token-file"]));
  if (dir && tokenFile.startsWith(dir + sep)) throw new Error("the token file is inside the folder to publish; keep it in .openmausbot-secrets");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error("the token file is empty");

  const scrub = (text) => String(text).split(token).join("[token]");
  try {
    const base = apiBase(env);
    const auth = { Authorization: `Bearer ${token}` };
    const api = async (step, method, path, json) => {
      const response = await request(`${base}${path}`, { method, headers: { ...auth, ...(json ? { "Content-Type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined }, env);
      if (response.status < 200 || response.status >= 300) throw new NetlifyError(step, response);
      return JSON.parse(response.text);
    };
    const siteFile = join(project, SITE_FILE);
    let site = readSiteRecord(siteFile);
    const makePublic = () => api("Making the site public", "PATCH", `/sites/${site.siteId}`, { sso_login: false });

    if (!dir) {
      if (!site) throw new Error(`${siteFile} is missing; publish the site first`);
      await makePublic();
      return { ok: true, created: false, draft: false, siteId: site.siteId, name: site.name, url: site.url, adminUrl: site.adminUrl, ...(await checkLink(site.url, env, Date.now() + waitMs, pollMs)) };
    }

    const { files, skipped } = collectFiles(dir);
    if (!files.some((file) => file.path === "index.html")) throw new Error(`${args.dir} has no index.html at its top; publish the built output folder`);
    const { digest, bySha } = buildDigest(files);
    const leaking = files.find((file) => readFileSync(file.full).includes(token));
    if (leaking) throw new Error(`${leaking.path} contains the Netlify token; remove it before publishing`);

    const created = !site;
    if (!site) {
      const made = await api("Creating the site", "POST", "/sites", args.name ? { name: args.name } : {});
      site = { siteId: made.id, name: made.name, url: made.ssl_url || made.url, adminUrl: made.admin_url };
      writeFileSync(siteFile, `${JSON.stringify(site, null, 2)}\n`);
    }
    if (args.public) await makePublic();

    let deploy = await api("Starting the deploy", "POST", `/sites/${site.siteId}/deploys`, {
      files: digest,
      ...(args.draft ? { draft: true } : {}),
      ...(files.length >= ASYNC_FROM_FILES ? { async: true } : {}),
    });
    const deadline = Date.now() + waitMs;
    while (!Array.isArray(deploy.required) && deploy.state === "preparing" && Date.now() < deadline) {
      await wait(pollMs);
      deploy = await api("Preparing the deploy", "GET", `/sites/${site.siteId}/deploys/${deploy.id}`);
    }
    const required = [...new Set(deploy.required ?? [])];
    const queue = required.map((sha) => bySha.get(sha)).filter(Boolean);
    const upload = async (file) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const response = await request(`${base}/deploys/${deploy.id}/files/${uploadPath(file.path)}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: readFileSync(file.full) }, env);
          if (response.status >= 200 && response.status < 300) return;
          if (response.status < 500 || attempt === UPLOAD_TRIES) throw new NetlifyError(`Uploading ${file.path}`, response);
        } catch (error) {
          if (error instanceof NetlifyError || attempt === UPLOAD_TRIES) throw error;
        }
        await wait(pollMs);
      }
    };
    await Promise.all(Array.from({ length: UPLOADS_AT_ONCE }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) await upload(file);
    }));

    let state = deploy.state;
    while (state !== "ready" && state !== "error" && Date.now() < deadline) {
      await wait(pollMs);
      deploy = await api("Checking the deploy", "GET", `/sites/${site.siteId}/deploys/${deploy.id}`);
      state = deploy.state;
    }
    if (state === "error") throw new Error(`Netlify could not process the deploy${deploy.error_message ? `: ${deploy.error_message}` : ""}`);

    const url = args.draft ? deploy.deploy_ssl_url || deploy.deploy_url : deploy.ssl_url || deploy.url || site.url;
    let link = { live: false, access: "unknown", liveStatus: 0 };
    if (state === "ready" && url) {
      link = await checkLink(url, env, args.public ? deadline : Math.min(deadline, Date.now() + privateWaitMs), pollMs);
      if (link.access !== "private" && !link.live) link = await checkLink(url, env, deadline, pollMs);
    }
    if (!args.draft && url && url !== site.url) {
      site = { ...site, url };
      writeFileSync(siteFile, `${JSON.stringify(site, null, 2)}\n`);
    }
    return {
      ok: true, created, draft: args.draft, siteId: site.siteId, name: site.name, url, adminUrl: site.adminUrl, deployId: deploy.id, state, ...link,
      files: files.length, uploaded: required.length, bytes: files.reduce((sum, file) => sum + file.size, 0), skipped,
    };
  } catch (error) {
    throw new Error(scrub(error.message));
  }
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url : false;
if (invoked) {
  publish(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.log(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    },
  );
}
