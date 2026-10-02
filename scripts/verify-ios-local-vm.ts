// Fake-engine server + synthetic Local VM + companion sidecar, in disposable
// homes, for checking the iOS computer view against a Local VM by hand.
//
//   node --experimental-strip-types scripts/verify-ios-local-vm.ts
//
// Prints the sidecar address and a pairing code for the Simulator, then stays
// up until Ctrl-C. The synthetic `docker` answers only inspection and the two
// screenshot execs; each capture returns the captured desktop with another
// character typed at its prompt, so a refresh is visible on the phone. It never reaches a real container runtime,
// VM, or the user's OpenMausBot data.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { launchVerificationServer, type VerificationServer } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";
import { fakeVncDesktop } from "./testing/fake-vnc-desktop.ts";
import { decodePng } from "./testing/png.ts";
import { createServer as createHttpServer } from "node:http";
import { BASE_IMAGE_DIGEST, CUA_DRIVER_VERSION, IMAGE, IMAGE_LAYER_VERSION, TARGET_LABEL, perBotLocalVmTarget } from "../server/container-computer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The synthetic desktop: a captured Local VM session (an XFCE desktop with
 * a terminal open), with `frame` characters typed at the prompt so each
 * capture is distinct. The capture holds no account or network details. */
const captured = decodePng(readFileSync(join(root, "scripts/testing/fixtures/local-vm-desktop.png")));
function scene(frame: number): (x: number, y: number) => [number, number, number] {
  // The prompt's block cursor, in terminal cells of 9 by 16 pixels.
  const cursor = { x: 460, y: 153, w: 8, h: 16, step: 9 };
  const typed = frame % 4;
  return (x, y) => {
    if (y >= cursor.y && y < cursor.y + cursor.h && x >= cursor.x && x < cursor.x + cursor.step * (typed + 1)) {
      const cell = Math.floor((x - cursor.x) / cursor.step);
      const inGlyph = (x - cursor.x) % cursor.step < cursor.w;
      if (cell === typed) return inGlyph ? [0xff, 0xff, 0xff] : [0, 0, 0];
      // Typed characters: a lower-case run in the terminal's text colour.
      const ink = inGlyph && y >= cursor.y + 5 && y < cursor.y + 13 && (x - cursor.x) % cursor.step !== 3;
      return ink ? [0xd0, 0xd0, 0xd0] : [0, 0, 0];
    }
    return captured.pixel(x, y);
  };
}

/** A flat RGB PNG of `scene(frame)`, so each capture is distinct. */
function desktopPng(frame: number, width = 1280, height = 800): Buffer {
  const pixel = scene(frame);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
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
const fixtureTarget = join(scratch, "target.json");
mkdirSync(bin);
mkdirSync(frames);
for (let frame = 0; frame < 4; frame++) {
  writeFileSync(join(frames, `${frame}.b64`), desktopPng(frame).toString("base64"));
}
let fixture: VerificationServer | undefined;
let sidecar: ChildProcess | undefined;
// The VM's live desktop, behind VNC authentication like the real one.
const desktop = await fakeVncDesktop({ paint: scene(0) });
// A signal during server startup aborts it; the launcher then stops its child
// and removes its own data directory before the launch promise settles.
const startup = new AbortController();
let launching: Promise<VerificationServer> | undefined;
let stopping: Promise<void> | undefined;
const stop = () => stopping ??= (async () => {
  sidecar?.kill("SIGTERM");
  startup.abort();
  await launching?.catch(() => {});
  await desktop.close().catch(() => {});
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
const target = fs.existsSync(${JSON.stringify(fixtureTarget)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(fixtureTarget)}, 'utf8')) : null;
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
else if (args[0] === 'inspect' && (args[1] === 'openmausbot-computer' || args[1] === target?.containerName)) result = [{
  Config:{Image:${JSON.stringify(IMAGE)},Labels:args[1] === target?.containerName ? {...labels,${JSON.stringify(TARGET_LABEL)}:target.label} : labels,Env:['VNC_PW=fixture-password']},
  State:{Running:true},Image:imageId,
  Mounts:[{Type:'bind',Source:args[1] === target?.containerName
    ? require('node:path').join(process.env.OMB_DATA_DIR,'vm-homes',target.label.slice(0,16))
    : require('node:path').join(process.env.OMB_DATA_DIR,'vm-home'),Destination:'/home/cua/workspace',RW:true}],
  HostConfig:{PortBindings:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'${desktop.port}'}]},
    Privileged:false,Memory:4294967296,MemorySwap:4294967296,NanoCpus:2000000000,PidsLimit:512,
    CapDrop:['ALL'],CapAdd:['CAP_SETUID','CAP_SETGID'],IpcMode:'private',ShmSize:536870912,
    CgroupnsMode:'private',SecurityOpt:[],RestartPolicy:{Name:'no',MaximumRetryCount:0}},
  NetworkSettings:{Ports:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'${desktop.port}'}]}}
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
  const target = perBotLocalVmTarget(bot.id);
  writeFileSync(fixtureTarget, JSON.stringify({ containerName: target.containerName, label: target.label }));
  await api("PATCH", "/api/config", { localVm: { mode: "per-bot" } });
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
  // What the phone has done to the desktop, and who holds the computer.
  const eventsPort = await freePort();
  createHttpServer(async (_req, res) => {
    const control = await api("GET", `/api/bots/${bot.id}/computer/control`).catch(() => null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      connections: desktop.connections(),
      authenticated: desktop.authResponses.length,
      pointerEvents: desktop.pointer.length,
      lastPointer: desktop.pointer.at(-1) ?? null,
      clicks: desktop.pointer.filter((event, index, all) => event.buttons & 1 && !((all[index - 1]?.buttons ?? 0) & 1)).length,
      typed: desktop.typed(),
      keys: desktop.keys.length,
      controlHeld: control?.held ?? null,
    }, null, 2));
  }).listen(eventsPort, "127.0.0.1");
  console.log(`Desktop events and control state: http://127.0.0.1:${eventsPort}/`);
  console.log("Ctrl-C stops everything and removes the temporary data.");
  await new Promise(() => {});
} catch (error) {
  console.error(error);
  await stop();
  process.exit(1);
}
