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
  const args = { draft: false, public: false, check: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (flag === "--draft") args.draft = true;
    else if (flag === "--make-public") args.public = true;
    else if (flag === "--check") args.check = true;
    else if (["--dir", "--token-file", "--project", "--name", "--title", "--bot-name"].includes(flag) && argv[at + 1]) args[flag.slice(2)] = argv[(at += 1)];
    else throw new Error(`unknown or incomplete option ${flag}`);
  }
  if (!args["token-file"] || !(args.dir || args.public || args.check)) {
    throw new Error("usage: node deploy.mjs --dir <folder to publish> --token-file <secret file> [--project <folder>] [--name <site name>] [--title <title>] [--bot-name <your name>] [--draft] [--make-public] | --check --token-file <secret file> | --make-public --token-file <secret file>");
  }
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

const RECORD_KEYS = ["version", "siteId", "name", "url", "adminUrl", "title", "botId", "botName", "createdAt", "publishedAt", "deployId", "deployState", "access"];
const oneLine = (value, max) => String(value).replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, max);

/** `.netlify-site.json`, a contract other code reads: known keys only, in a fixed order, and never the token. */
export function siteRecord(fields) {
  const record = { version: 1 };
  for (const key of RECORD_KEYS) if (fields[key] !== undefined && fields[key] !== null && fields[key] !== "") record[key] = fields[key];
  return record;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Netlify (2026-11): a new account's sites answer 401 with a redirect to its team login until `sso_login` is turned
 * off on the site, so a 401 is a deployed site that only the account's team can open. Turning it off takes a few
 * seconds to show, so `expectPublic` waits through 401s. */
async function checkLink(url, env, { pollMs, waitMs, privateAfterMs, expectPublic }) {
  const started = Date.now();
  for (;;) {
    const { status, type } = await request(url, {}, env).then((response) => ({ status: response.status, type: String(response.headers["content-type"] ?? "") }), () => ({ status: 0, type: "" }));
    const waited = Date.now() - started;
    if (status === 200) return { live: /^text\/html\b/i.test(type), access: "public", liveStatus: status, contentType: type };
    if (status === 401 && (waited >= waitMs || (!expectPublic && waited >= privateAfterMs))) return { live: false, access: "private", liveStatus: status };
    if (waited >= waitMs) {
      return status === 0
        ? { live: false, liveStatus: 0, message: "Netlify finished the deploy, but the link could not be reached from here. Run again with --check." }
        : { live: false, access: "public", liveStatus: status, contentType: type };
    }
    await wait(pollMs);
  }
}

export async function publish(argv, env = process.env, { pollMs = 2000, waitMs = 240_000, linkWaitMs = 60_000, privateAfterMs = 6000, now = () => new Date() } = {}) {
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
    const save = (changes) => {
      site = siteRecord({ ...site, ...changes });
      writeFileSync(siteFile, `${JSON.stringify(site, null, 2)}\n`);
    };
    const makePublic = () => api("Making the site public", "PATCH", `/sites/${site.siteId}`, { sso_login: false });

    /** Waits for Netlify to finish a deploy, then for its link. A deploy still being processed at the deadline is
     * neither a success nor a failure: the answer says so and `--check` picks it up. */
    const finish = async (deploy, { draft, expectPublic, firstLook }) => {
      const deadline = Date.now() + waitMs;
      while (deploy.state !== "ready" && deploy.state !== "error" && Date.now() < deadline) {
        await wait(pollMs);
        deploy = await api("Checking the deploy", "GET", `/sites/${site.siteId}/deploys/${deploy.id}`);
      }
      const state = deploy.state;
      if (state === "error") {
        if (!draft) save({ deployState: state });
        throw new Error(`Netlify could not process the deploy${deploy.error_message ? `: ${deploy.error_message}` : ""}`);
      }
      const url = draft ? deploy.deploy_ssl_url || deploy.deploy_url : deploy.ssl_url || deploy.url || site.url;
      const common = { ok: true, draft, siteId: site.siteId, name: site.name, url, adminUrl: site.adminUrl, deployId: deploy.id, state };
      if (state !== "ready") {
        if (!draft) save({ deployState: state });
        return { ...common, pending: true, live: false, message: `Netlify is still processing this deploy (${state}). It is not live yet and has not failed. Run again with --check in a minute.` };
      }
      const link = await checkLink(url, env, { pollMs, waitMs: linkWaitMs, privateAfterMs, expectPublic });
      if (!draft) save({ url, deployState: state, ...(link.access ? { access: link.access } : {}), ...(firstLook ? { publishedAt: now().toISOString() } : {}) });
      return { ...common, ...link };
    };

    if (!dir) {
      if (!site) throw new Error(`${siteFile} is missing; publish the site first`);
      if (args.public) await makePublic();
      if (!site.deployId) return { ok: true, draft: false, siteId: site.siteId, name: site.name, url: site.url, adminUrl: site.adminUrl, ...(await checkLink(site.url, env, { pollMs, waitMs: linkWaitMs, privateAfterMs, expectPublic: args.public })) };
      const deploy = await api("Checking the deploy", "GET", `/sites/${site.siteId}/deploys/${site.deployId}`);
      return await finish(deploy, { draft: false, expectPublic: args.public, firstLook: site.deployState !== "ready" || !site.publishedAt });
    }

    const { files, skipped } = collectFiles(dir);
    if (!files.some((file) => file.path === "index.html")) throw new Error(`${args.dir} has no index.html at its top; publish the built output folder`);
    const { digest, bySha } = buildDigest(files);
    const leaking = files.find((file) => readFileSync(file.full).includes(token));
    if (leaking) throw new Error(`${leaking.path} contains the Netlify token; remove it before publishing`);

    const created = !site;
    const labels = {
      ...(args.title ? { title: oneLine(args.title, 120) } : {}),
      ...(args["bot-name"] ? { botName: oneLine(args["bot-name"], 80) } : {}),
      ...(/^[\w-]{1,80}$/.test(env.OMB_BOT_ID ?? "") ? { botId: env.OMB_BOT_ID } : {}),
    };
    if (!site) {
      const made = await api("Creating the site", "POST", "/sites", args.name ? { name: args.name } : {});
      save({ siteId: made.id, name: made.name, url: made.ssl_url || made.url, adminUrl: made.admin_url, title: made.name, createdAt: now().toISOString(), ...labels });
    } else if (Object.keys(labels).length && !args.draft) {
      save(labels);
    }
    if (args.public) await makePublic();

    let deploy = await api("Starting the deploy", "POST", `/sites/${site.siteId}/deploys`, {
      files: digest,
      ...(args.draft ? { draft: true } : {}),
      ...(files.length >= ASYNC_FROM_FILES ? { async: true } : {}),
    });
    if (!args.draft) save({ deployId: deploy.id, deployState: deploy.state });
    const prepared = Date.now() + waitMs;
    while (!Array.isArray(deploy.required) && deploy.state === "preparing" && Date.now() < prepared) {
      await wait(pollMs);
      deploy = await api("Preparing the deploy", "GET", `/sites/${site.siteId}/deploys/${deploy.id}`);
    }
    const required = [...new Set(deploy.required ?? [])];
    const unknown = required.find((sha) => !bySha.has(sha));
    if (unknown) throw new Error(`Netlify asked for a file this folder does not have (${unknown})`);
    const queue = required.map((sha) => bySha.get(sha));
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

    return {
      ...(await finish(deploy, { draft: args.draft, expectPublic: args.public, firstLook: true })), created,
      files: files.length, uploaded: required.length, alreadyOnNetlify: new Set(Object.values(digest)).size - required.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0), skipped,
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
