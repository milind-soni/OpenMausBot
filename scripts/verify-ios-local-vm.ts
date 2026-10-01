// Fake-engine server + synthetic Local VM + companion sidecar, in disposable
// homes, for checking the iOS computer view against a Local VM by hand.
//
//   node --experimental-strip-types scripts/verify-ios-local-vm.ts
//
// Prints the sidecar address and a pairing code for the Simulator, then stays
// up until Ctrl-C. The synthetic `docker` answers only inspection and the two
// screenshot execs; each capture returns a different synthetic desktop, so a
// refresh is visible on the phone. It never reaches a real container runtime,
// VM, or the user's OpenMausBot data.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { launchVerificationServer, type VerificationServer } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";
import { BASE_IMAGE_DIGEST, CUA_DRIVER_VERSION, IMAGE, IMAGE_LAYER_VERSION } from "../server/container-computer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A flat RGB PNG: dark desktop, top panel, one window, and a tile whose
 * colour and position change with `frame` so each capture is distinct. */
function desktopPng(frame: number, width = 1280, height = 800): Buffer {
  const tile = [[0xe8, 0x5d, 0x3f], [0x3f, 0xa7, 0xe8], [0x5c, 0xc4, 0x6a], [0xe8, 0xc2, 0x3f]][frame % 4];
  const tileX = 760 + (frame % 4) * 90;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      let rgb = [0x1a, 0x24, 0x36];
      if (y < 28) rgb = [0xee, 0xee, 0xee];
      else if (x >= 120 && x < 680 && y >= 120 && y < 520) rgb = y < 150 ? [0xd8, 0xd8, 0xd8] : [0x0b, 0x0b, 0x0b];
      else if (x >= tileX && x < tileX + 80 && y >= 300 && y < 380) rgb = tile;
      raw.set(rgb, row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`${url}: process exited (${child.exitCode})`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} did not come up`);
}

const scratch = mkdtempSync(join(tmpdir(), "omb-ios-local-vm-"));
const bin = join(scratch, "bin");
const frames = join(scratch, "frames");
mkdirSync(bin);
mkdirSync(frames);
for (let frame = 0; frame < 4; frame++) {
  writeFileSync(join(frames, `${frame}.b64`), desktopPng(frame).toString("base64"));
}
let fixture: VerificationServer | undefined;
let sidecar: ChildProcess | undefined;
// A signal during server startup aborts it; the launcher then stops its child
// and removes its own data directory before the launch promise settles.
const startup = new AbortController();
let launching: Promise<VerificationServer> | undefined;
let stopping: Promise<void> | undefined;
const stop = () => stopping ??= (async () => {
  sidecar?.kill("SIGTERM");
  startup.abort();
  await launching?.catch(() => {});
  await fixture?.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
})();
process.once("SIGINT", () => void stop().then(() => process.exit(0)));
process.once("SIGTERM", () => void stop().then(() => process.exit(0)));

try {
  // Read-only inspection plus the two screenshot execs. Anything else fails,
  // so no command can reach a real container runtime.
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs = require('node:fs');
let args = process.argv.slice(2);
if (args[0] === '-H') args = args.slice(2);
const labels = ${JSON.stringify({ "com.openmausbot.local-vm": "1", "com.openmausbot.cua-driver": CUA_DRIVER_VERSION, "com.openmausbot.cua-base": BASE_IMAGE_DIGEST, "com.openmausbot.image-layer": IMAGE_LAYER_VERSION, "com.openmausbot.workspace": "1" })};
const imageId = 'sha256:' + 'a'.repeat(64);
const counter = ${JSON.stringify(join(scratch, "captures"))};
let result;
if (args[0] === 'exec' && args.includes('base64')) {
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  result = fs.readFileSync(${JSON.stringify(frames)} + '/' + (n % 4) + '.b64', 'utf8');
}
else if (args[0] === 'exec') result = args.includes('--version') ? 'cua-driver ${CUA_DRIVER_VERSION}'
  : args.includes('health_report') ? {schema_version:'1',overall:'ok',checks:[]} : {};
else if (args[0] === 'info') result = 'fixture';
else if (args[0] === 'image' && args[1] === 'inspect') result = [{Id:imageId,Config:{Labels:labels}}];
else if (args[0] === 'inspect' && args[1] === 'openmausbot-computer') result = [{
  Config:{Image:${JSON.stringify(IMAGE)},Labels:labels,Env:['VNC_PW=fixture-password']},
  State:{Running:true},Image:imageId,
  Mounts:[{Type:'bind',Source:require('node:path').join(process.env.OMB_DATA_DIR,'vm-home'),Destination:'/home/cua/workspace',RW:true}],
  HostConfig:{PortBindings:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'6999'}]},
    Privileged:false,Memory:4294967296,MemorySwap:4294967296,NanoCpus:2000000000,PidsLimit:512,
    CapDrop:['ALL'],CapAdd:['CAP_SETUID','CAP_SETGID'],IpcMode:'private',ShmSize:536870912,
    CgroupnsMode:'private',SecurityOpt:[],RestartPolicy:{Name:'no',MaximumRetryCount:0}},
  NetworkSettings:{Ports:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'6999'}]}}
}];
else if (args[0] === 'ps') result = '';
else process.exit(1);
process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
`, { mode: 0o700 });

  launching = launchVerificationServer(process.env, startup.signal, {
    binDir: bin, host: "ssh://127.0.0.1:1", sshKey: join(scratch, "unused-key"), staticDir: join(root, "dist"),
  });
  fixture = await launching;
  const api = fixtureApi(fixture.info.url);
  const { bot } = await api("POST", "/api/bots", {
    name: "Vee", description: "Works on the Local VM.", modelSelection: { instanceId: "claude", model: "claude-sonnet-4-5" },
  });
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
  const still = await api("POST", `/api/bots/${bot.id}/local-computer/screenshot?threadId=${bot.threadId}`);
  if (!String(still.image).startsWith("data:image/png;base64,")) throw new Error("fixture screenshot route did not return a PNG");

  const harnessPort = new URL(fixture.info.url).port;
  const companionPort = await freePort();
  const controlPort = await freePort();
  const companionHome = join(scratch, "companion-home");
  mkdirSync(companionHome);
  sidecar = spawn(process.execPath, ["--experimental-strip-types", join(root, "companion", "src", "index.ts")], {
    env: {
      PATH: process.env.PATH,
      HOME: companionHome,
      USERPROFILE: companionHome,
      OMB_PORT: harnessPort,
      OMB_COMPANION_PORT: String(companionPort),
      OMB_CONTROL_PORT: String(controlPort),
      OMB_COMPANION_DIR: join(companionHome, "companion"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitFor(`http://127.0.0.1:${controlPort}/state`, sidecar);
  const { code } = await (await fetch(`http://127.0.0.1:${controlPort}/pairing`, { method: "POST" })).json() as { code: string };

  console.log(JSON.stringify({
    harness: fixture.info.url,
    companion: `127.0.0.1:${companionPort}`,
    control: `http://127.0.0.1:${controlPort}`,
    pairingCode: code,
    bot: { id: bot.id, threadId: bot.threadId },
    log: fixture.info.logPath,
  }, null, 2));
  console.log("Pair the Simulator with the address and code above. Allow computer view with:");
  console.log(`  curl -X POST http://127.0.0.1:${controlPort}/devices/<device-id>/cloud-desktop`);
  console.log("Ctrl-C stops everything and removes the temporary data.");
  await new Promise(() => {});
} catch (error) {
  console.error(error);
  await stop();
  process.exit(1);
}
