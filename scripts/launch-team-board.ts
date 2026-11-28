// A throwaway Team Cloud on this computer for a real-model pass over the Team Board (docs/verification/team-board.md).
// Everything lives in a new temp folder (its HOME and its data folder), an Owner and a Member
// are paired the way the Admin pairs them, and the tokens and a few curl lines are printed. It runs until Ctrl-C and
// then removes the folder. Only the provider keys named below cross from this shell into the server.
//   node --experimental-strip-types scripts/launch-team-board.ts [--offline]
// --offline: the server reaches nothing but this computer (a check that it starts and pairs, with no model to answer).
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudPairingSignature } from "../server/cloud-home.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "omb-team-board.local.test";
const EDGE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };
const TEAM = { id: "team-board-local", name: "Board test" };
/** The only variables that cross from this shell: provider keys, and the board's test clock if you want it faster. */
const PASS_THROUGH = ["OMB_ANTHROPIC_API_KEY", "OMB_OPENAI_API_KEY", "OMB_OPENROUTER_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_URL",
  "OPENAI_COMPAT_MODEL", "OPENAI_COMPAT_PROVIDER", "OMB_BOARD_TIME_SCALE"];

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

const root = mkdtempSync(join(tmpdir(), "omb-team-board-"));
const dataDir = join(root, ".openmausbot");
mkdirSync(dataDir, { recursive: true });
const port = await freePort();
const secret = randomBytes(32).toString("base64url");
const base = `http://127.0.0.1:${port}`;
const passed = Object.fromEntries(PASS_THROUGH.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline", { status: 503 });')}`;
const child = spawn(process.execPath, [...(process.argv.includes("--offline") ? ["--import", offline] : []), join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH, HOME: root, USERPROFILE: root, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    OMB_CLOUD_ROLE: "team", OMB_CLOUD_TEAM_ID: TEAM.id, OMB_CLOUD_TEAM_NAME: TEAM.name, OMB_CLOUD_MACHINE_ID: randomUUID(),
    OMB_CLOUD_ADMIN_URL: "https://cloud.example.test", OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`, ...passed,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => { child.kill("SIGTERM"); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => { rmSync(root, { recursive: true, force: true }); console.log(`\nTeam Cloud stopped (${code ?? "signal"}); removed ${root}`); process.exit(0); });

for (const deadline = Date.now() + 60_000; ;) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  if (Date.now() > deadline) { console.error("The Team Cloud did not start."); stop(); break; }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** A session for one teammate, paired with the Admin's signed claims. */
async function pair(email: string, role: "owner" | "member"): Promise<string> {
  const body = JSON.stringify({ label: "Board test", ttlSeconds: 300, team: TEAM, member: { email, role } });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const minted = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: { ...EDGE, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body });
  if (!minted.ok) throw new Error(`pairing ${email}: ${minted.status} ${await minted.text()}`);
  const { code } = await minted.json() as { code: string };
  const paired = await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  if (!paired.ok) throw new Error(`pair ${email}: ${paired.status} ${await paired.text()}`);
  return ((await paired.json()) as { token: string }).token;
}

const owner = await pair("olive@board.test", "owner");
const member = await pair("mira@board.test", "member");
const headers = `-H 'host: ${HOST}' -H 'x-forwarded-proto: https' -H 'x-forwarded-for: 203.0.113.9' -H 'origin: https://${HOST}' -H 'content-type: application/json'`;
console.log(`
Team Cloud: ${base}   (data: ${dataDir})
Provider keys passed: ${Object.keys(passed).join(", ") || "none"}
OWNER=${owner}
MEMBER=${member}
H="${headers.replaceAll('"', '\\"')}"

  curl -s $H -H "authorization: Bearer $OWNER" ${base}/api/instances      # engines and their models
  curl -s $H -H "authorization: Bearer $OWNER" ${base}/api/board          # the board
Ctrl-C stops it and removes the folder.`);
