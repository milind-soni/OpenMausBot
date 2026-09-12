import { mkdirSync, chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";
import { z } from "zod";
import { fleetRequest } from "../../../server/fleet-client.ts";
import { verifyLicenseKey } from "../../server/license.ts";
import { acquireDataDirLeaseForProcess } from "../../../server/data-dir-lease.ts";
import { createPortal } from "./portal.ts";
import { portalHttpServer } from "./http.ts";
import { PortalStore, normalizeEmail } from "./store.ts";
import type { PortalConfig } from "./auth.ts";
import { createConnection } from "node:net";

process.umask(0o077);
const env = z.object({
  OMB_ADMIN_URL: z.url(),
  OMB_ADMIN_SECRET: z.string().min(32),
  OMB_ADMIN_EMAILS: z.string().min(3),
  OMB_ADMIN_DATA_DIR: z.string().min(1),
  OMB_LICENSE_KEY: z.string().min(1),
  OMB_ADMIN_SMTP_URL: z.string().url(),
  OMB_ADMIN_MAIL_FROM: z.string().min(3),
  OMB_ADMIN_SOCKET: z.string().default("/run/openmausbot-admin/http.sock"),
  OMB_ADMIN_NAME: z.string().trim().min(1).max(80).default("OpenMausBot"),
  OMB_FLEET_SOCKET: z.string().default("/run/openmausbot/fleet.sock"),
  OMB_ADMIN_GOOGLE_CLIENT_ID: z.string().optional(), OMB_ADMIN_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OMB_ADMIN_GITHUB_CLIENT_ID: z.string().optional(), OMB_ADMIN_GITHUB_CLIENT_SECRET: z.string().optional(),
}).parse(process.env);
if (process.getuid?.() === 0) throw new Error("Run the Admin portal as a separate unprivileged user, not root or a bot's workspace user.");
const origin = new URL(env.OMB_ADMIN_URL);
if (origin.protocol !== "https:" || origin.origin !== env.OMB_ADMIN_URL) throw new Error("OMB_ADMIN_URL must be the exact HTTPS origin, without a path or credentials.");
const admins = env.OMB_ADMIN_EMAILS.split(",").map((email) => z.email().parse(normalizeEmail(email)));
const licensed = () => {
  try { return verifyLicenseKey(env.OMB_LICENSE_KEY).features.includes("admin"); } catch { return false; }
};
if (!licensed()) throw new Error("An active license with the admin entitlement is required.");
const smtp = new URL(env.OMB_ADMIN_SMTP_URL);
if (!["smtp:", "smtps:"].includes(smtp.protocol)) throw new Error("Use an smtp:// or smtps:// mail server URL.");
const mail = nodemailer.createTransport({
  host: smtp.hostname, port: smtp.port ? Number(smtp.port) : smtp.protocol === "smtps:" ? 465 : 587,
  secure: smtp.protocol === "smtps:", requireTLS: true,
  ...(smtp.username ? { auth: { user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password) } } : {}),
  connectionTimeout: 10_000, socketTimeout: 30_000,
});
function social(id?: string, secret?: string) {
  if (Boolean(id) !== Boolean(secret)) throw new Error("Both OAuth client ID and client secret must be configured.");
  return id && secret ? { clientId: id, clientSecret: secret } : undefined;
}
const config: PortalConfig = {
  url: origin.origin, secret: env.OMB_ADMIN_SECRET, admins, name: env.OMB_ADMIN_NAME,
  google: social(env.OMB_ADMIN_GOOGLE_CLIENT_ID, env.OMB_ADMIN_GOOGLE_CLIENT_SECRET),
  github: social(env.OMB_ADMIN_GITHUB_CLIENT_ID, env.OMB_ADMIN_GITHUB_CLIENT_SECRET),
};
const dataDir = resolve(env.OMB_ADMIN_DATA_DIR);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const lease = acquireDataDirLeaseForProcess(dataDir);
const db = new DatabaseSync(resolve(dataDir, "admin.sqlite"));
const store = new PortalStore(db);
const portal = await createPortal({ config, store, licensed,
  fleet: (method, path, body) => fleetRequest(env.OMB_FLEET_SOCKET, method, path, body, method === "GET" ? 5_000 : undefined),
  sendMail: async (message) => { await mail.sendMail({ from: env.OMB_ADMIN_MAIL_FROM, ...message }); },
});
const here = dirname(fileURLToPath(import.meta.url));
const webDir = import.meta.url.endsWith(".ts") ? resolve(here, "../dist/web") : resolve(here, "web");
const server = portalHttpServer({ url: config.url, webDir, handle: portal.handle });
const socketPath = resolve(env.OMB_ADMIN_SOCKET);
const socketParent = lstatSync(dirname(socketPath));
if (!socketParent.isDirectory() || socketParent.uid !== process.getuid?.() || (socketParent.mode & 0o007)) throw new Error("The portal socket directory must be private and owned by its service user.");
if (existsSync(socketPath)) {
  const socket = lstatSync(socketPath);
  if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error("Refusing to replace an unknown socket path.");
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("The portal socket did not answer; refusing to replace it.")); });
    probe.once("connect", () => { probe.destroy(); reject(new Error("Another service is listening on the portal socket.")); });
    probe.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
  unlinkSync(socketPath);
}
server.listen(socketPath, () => { chmodSync(socketPath, 0o660); console.log("Admin portal listening on its private socket."); });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  portal.gateway.close();
  server.close(() => { db.close(); mail.close(); lease.release(); });
};
process.once("SIGTERM", stop); process.once("SIGINT", stop);
