import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DEFAULT_LIMITS, type Limits, type RelayConfig } from "../src/config.ts";
import type { LogEvent } from "../src/log.ts";
import { startRelay, type Relay } from "../src/server.ts";
import { parseTokenKeys } from "../src/token.ts";
import { sha256, SUBPROTOCOL } from "../src/wire.ts";

export const RELAY_DIR = fileURLToPath(new URL("..", import.meta.url));

export interface TestKey {
  kid: string;
  publicB64u: string;
  privateKey: KeyObject;
}

export function testKey(kid = "k1"): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { kid, publicB64u: publicKey.export({ format: "jwk" }).x!, privateKey };
}

export const keysJson = (...keys: TestKey[]) => JSON.stringify(Object.fromEntries(keys.map((key) => [key.kid, key.publicB64u])));

export interface Claims {
  v?: unknown;
  kid?: unknown;
  hid?: unknown;
  iid?: unknown;
  iat?: unknown;
  exp?: unknown;
}

export function mintToken(key: TestKey, claims: Claims = {}, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = { v: 1, kid: key.kid, hid: randomBytes(16).toString("base64url"), iid: "00000000-0000-4000-8000-000000000000", iat: nowSeconds, exp: nowSeconds + 12 * 3600, ...claims };
  const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${part}.${sign(null, Buffer.from(part, "ascii"), key.privateKey).toString("base64url")}`;
}

let nextAddress = 0;
/** A distinct address from 198.18.0.0/15 (set aside for testing), so each test client has its own per-IP limits. */
export function freshIp(): string {
  nextAddress = (nextAddress + 1) % 131_072;
  return `198.${18 + (nextAddress >> 16)}.${(nextAddress >> 8) & 255}.${nextAddress & 255}`;
}

export interface Received {
  data: Buffer;
  binary: boolean;
}

export interface Closed {
  code: number;
  reason: string;
}

export interface ConnectOptions {
  ip?: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

/** A WebSocket client that queues what it receives, so a test can await each message and the close in order. */
export class Client {
  readonly ws: WebSocket;
  readonly closed: Promise<Closed>;
  private readonly queue: Received[] = [];
  private readonly waiting: Array<(message: Received) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on("message", (data, binary) => {
      const message = { data: data as Buffer, binary };
      const waiter = this.waiting.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    ws.on("error", () => {});
  }

  static async open(url: string, path: string, options: ConnectOptions = {}): Promise<Client> {
    const ws = new WebSocket(`${url}${path}`, options.protocols ?? [SUBPROTOCOL], {
      headers: { "x-forwarded-for": options.ip ?? freshIp(), ...options.headers },
      perMessageDeflate: false,
      maxPayload: 1 << 30,
    });
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.once("error", reject);
    });
    return client;
  }

  /** The HTTP status a refused upgrade answers with. */
  static async refusal(url: string, path: string, options: ConnectOptions = {}): Promise<number> {
    try {
      const client = await Client.open(url, path, options);
      client.ws.terminate();
      return 101;
    } catch (error) {
      return (error as { status?: number }).status ?? 0;
    }
  }

  send(value: unknown): void {
    this.ws.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  sendBinary(data: Buffer): void {
    this.ws.send(data, { binary: true });
  }

  next(timeoutMs = 5_000): Promise<Received> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(new Error(`no message within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = (message: Received) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiting.push(waiter);
    });
  }

  async json(timeoutMs?: number): Promise<Record<string, unknown>> {
    const { data, binary } = await this.next(timeoutMs);
    if (binary) throw new Error("expected a text message");
    return JSON.parse(data.toString("utf8"));
  }

  async closeCode(timeoutMs = 5_000): Promise<number> {
    return (await this.closedWithin(timeoutMs)).code;
  }

  closedWithin(timeoutMs = 5_000): Promise<Closed> {
    return Promise.race([
      this.closed,
      new Promise<Closed>((_, reject) => setTimeout(() => reject(new Error(`still open after ${timeoutMs} ms`)), timeoutMs).unref()),
    ]);
  }
}

export interface TestRelay {
  relay: Relay;
  url: string;
  key: TestKey;
  logs: LogEvent[];
  stop: () => Promise<void>;
}

/** A relay in this process on a free port, with `limits` overriding the spec values. */
export async function startTestRelay(limits: Partial<Limits> = {}, options: { wallSeconds?: () => number; key?: TestKey } = {}): Promise<TestRelay> {
  const key = options.key ?? testKey();
  const logs: LogEvent[] = [];
  const config: RelayConfig = {
    node: "relay1",
    host: "127.0.0.1",
    port: 0,
    tokenKeys: parseTokenKeys(keysJson(key)),
    metricsToken: "m".repeat(40),
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
  const relay = await startRelay(config, { log: (event) => logs.push(event), wallSeconds: options.wallSeconds });
  return { relay, url: `ws://127.0.0.1:${relay.port}`, key, logs, stop: () => relay.close() };
}

export interface SpawnedRelay {
  proc: ChildProcess;
  url: string;
  httpUrl: string;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  stop: () => Promise<void>;
}

/** `node src/main.ts` as a child process, configured only through its environment. */
export async function spawnRelay(env: Record<string, string>): Promise<SpawnedRelay> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
    cwd: RELAY_DIR,
    env: { PATH: process.env.PATH ?? "", RELAY_HOST: "127.0.0.1", RELAY_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stdout!.on("data", (chunk) => (out += chunk));
  proc.stderr!.on("data", (chunk) => (err += chunk));
  const exited = once(proc, "exit").then(([code]) => code as number | null);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${err}`)), 10_000);
    const look = () => {
      const start = out.split("\n").map((line) => (line.startsWith("{") ? JSON.parse(line) : undefined)).find((line) => line?.ev === "start");
      if (start) {
        clearTimeout(timer);
        resolve(start.port);
      }
    };
    proc.stdout!.on("data", look);
    exited.then(() => reject(new Error(`relay exited: ${err}`)));
  });
  return {
    proc,
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    stdout: () => out,
    stderr: () => err,
    exited,
    stop: async () => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await exited;
    },
  };
}

export interface FakeHost {
  control: Client;
  hid: Buffer;
  hidText: string;
  token: string;
  hello: Record<string, unknown>;
  admit: (adms: Buffer[]) => void;
  /** Waits for the relay's `open` and answers it with a data socket. */
  acceptPhone: () => Promise<Client>;
}

export async function fakeHost(url: string, key: TestKey, adms: Buffer[] = [], hid = randomBytes(16)): Promise<FakeHost> {
  const hidText = hid.toString("base64url");
  const token = mintToken(key, { hid: hidText });
  const control = await Client.open(url, "/v1/host");
  control.send({ t: "auth", v: 1, token });
  const hello = await control.json();
  const admit = (list: Buffer[]) => control.send({ t: "admit", set: list.map((adm) => sha256(adm).toString("base64url")) });
  admit(adms);
  const acceptPhone = async () => {
    const open = await control.json();
    if (open.t !== "open") throw new Error(`expected open, got ${JSON.stringify(open)}`);
    const data = await Client.open(url, "/v1/host/data");
    data.send({ t: "data", v: 1, sid: open.sid, token });
    return data;
  };
  return { control, hid, hidText, token, hello, admit, acceptPhone };
}

export async function phoneHello(url: string, hidText: string, adm: Buffer, options: ConnectOptions = {}): Promise<Client> {
  const phone = await Client.open(url, "/v1/phone", options);
  phone.send({ t: "phone", v: 1, hid: hidText, adm: adm.toString("base64url") });
  return phone;
}

/** A host with one admitted phone, spliced: both sides past `ready`. */
export async function splicedPair(url: string, key: TestKey): Promise<{ host: FakeHost; phone: Client; data: Client; adm: Buffer }> {
  const adm = randomBytes(32);
  const host = await fakeHost(url, key, [adm]);
  const phone = await phoneHello(url, host.hidText, adm);
  const data = await host.acceptPhone();
  const ready = await phone.json();
  if (ready.t !== "ready") throw new Error(`expected ready, got ${JSON.stringify(ready)}`);
  return { host, phone, data, adm };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
