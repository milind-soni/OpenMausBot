import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer, type RawData } from "ws";

import { b64u, concat, fromB64u, utf8, type Bytes } from "./bytes.ts";
import { admission, credentialHash, keyId, psk } from "./credentials.ts";
import type { SessionKeys } from "./noise.ts";
import { dial, dialRelay, PhoneSession, RELAY_PROTOCOL, SessionClosed, type E2EStream } from "./session.ts";

const SERVER = fileURLToPath(new URL("../../../companion/src/e2e/interop-server.ts", import.meta.url));
const BOUND_MS = 10_000;
const HOST_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

interface Ready {
  direct: string;
  relayTransport: string;
  wrongKey: string;
  k: string;
  deviceToken: string;
  pairingToken: string;
}

let child: ChildProcess;
let ready: Ready;
let remoteStatic: Bytes;

/** A relay node for tests, phone side of README section 9 only: one text message first, then 4404 unless it names the
 * test host with an admitted `adm`; otherwise it dials the computer, answers ready, and splices binary both ways. */
interface RelayNode {
  url: string;
  /** What phones sent before ready. */
  firstMessages: unknown[];
  /** Codes this node closed phones with, in order. */
  closes: number[];
  admitted: Set<string>;
  /** Refuse every phone with this code, as a full (4503) or rate-limiting (4429) node would. */
  refuseWith: number | null;
  /** The close reason sent with refuseWith. */
  refuseReason: string;
  /** The computer route it splices to; the real relay transport unless a test swaps in another responder. */
  computer: string | null;
  /** Close the phone with this code right after the computer's first message reaches it. */
  closeAfterFirst: number | null;
  /** Answer ready but never splice, so the handshake deadline passes. */
  stall: boolean;
  /** Drop everything the computer sends from now on, as a dead path would. */
  mute: boolean;
  close(): Promise<void>;
}

const nodes: RelayNode[] = [];

async function startNode(): Promise<RelayNode> {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, maxPayload: 70_000, handleProtocols: (offered) => (offered.has(RELAY_PROTOCOL) ? RELAY_PROTOCOL : false) });
  const node: RelayNode = {
    url: "",
    firstMessages: [],
    closes: [],
    admitted: new Set(),
    refuseWith: null,
    refuseReason: "",
    computer: null,
    closeAfterFirst: null,
    stall: false,
    mute: false,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
  const refuse = (socket: NodeWebSocket, code: number, reason?: string) => {
    node.closes.push(code);
    socket.close(code, reason);
  };
  wss.on("connection", (phone) => {
    if (node.refuseWith !== null) return refuse(phone, node.refuseWith, node.refuseReason);
    phone.once("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return refuse(phone, 4400);
      let first: { t?: unknown; v?: unknown; hid?: unknown; adm?: unknown };
      try {
        first = JSON.parse(String(raw)) as typeof first;
      } catch {
        return refuse(phone, 4400);
      }
      node.firstMessages.push(first);
      if (first.t !== "phone" || first.v !== 1) return refuse(phone, 4400);
      if (first.hid !== b64u(HOST_ID) || !node.admitted.has(String(first.adm))) return refuse(phone, 4404);
      if (node.stall) return void phone.send(JSON.stringify({ t: "ready" }));
      const data = new NodeWebSocket(node.computer ?? ready.relayTransport, "omb-e2e.v1");
      data.on("open", () => {
        phone.send(JSON.stringify({ t: "ready" }));
        phone.on("message", (bytes: RawData, binary: boolean) => (binary ? data.send(bytes as Buffer) : refuse(phone, 4400)));
        data.on("message", (bytes: RawData) => {
          if (node.mute || phone.readyState !== NodeWebSocket.OPEN) return;
          phone.send(bytes as Buffer);
          if (node.closeAfterFirst !== null) refuse(phone, node.closeAfterFirst);
        });
      });
      // Close codes pass through, as the real relay's splice does.
      const passClose = (to: NodeWebSocket) => (code: number) => {
        if (to.readyState === NodeWebSocket.OPEN) to.close(code >= 3000 ? code : 1000);
      };
      data.on("close", passClose(phone));
      phone.on("close", passClose(data));
      data.on("error", () => phone.terminate());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  node.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone`;
  nodes.push(node);
  return node;
}

beforeAll(async () => {
  child = spawn(process.execPath, [SERVER, "--port", "0", "--exit-with-stdin"], { stdio: ["pipe", "pipe", "ignore"] });
  ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("interop server did not say ready in 10 s")), BOUND_MS);
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").slice(0, -1).find((candidate) => candidate.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Ready);
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`interop server exited ${code}`)));
  });
  remoteStatic = fromB64u(ready.k)!;
});

afterAll(async () => {
  await Promise.all(nodes.map((node) => node.close()));
  child?.kill("SIGTERM");
});

async function credentials(token: string) {
  const credHash = await credentialHash(token);
  return { psk: await psk(credHash, await keyId(remoteStatic)), adm: await admission(credHash, HOST_ID) };
}

/** A node that admits the pairing token, and what a phone paired with that token dials it with. */
async function admittingNode() {
  const node = await startNode();
  const { psk: key, adm } = await credentials(ready.pairingToken);
  node.admitted.add(b64u(adm));
  return { node, options: { hostId: HOST_ID, adm, remoteStatic, psk: key, app: "web-test/1" } };
}

async function readAll(stream: E2EStream): Promise<Bytes> {
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(...chunks);
    chunks.push(value);
  }
}

/** Like an HTTP client: no half close while the reply comes (Node's HTTP server cuts a reply short on one). */
async function request(session: PhoneSession, head: string, body?: Bytes): Promise<Bytes> {
  const stream = session.open();
  await stream.write(utf8(head));
  if (body) await stream.write(body);
  const reply = await readAll(stream);
  stream.end();
  return reply;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const health = async (session: PhoneSession) => text(await request(session, "GET /api/health HTTP/1.1\r\nHost: companion\r\nConnection: close\r\n\r\n"));

describe("dialRelay: the browser phone through a relay node", () => {
  it("sends the pre-auth message, waits for ready, handshakes with the relay prologue and carries requests", async () => {
    const stranger = await startNode();
    const { node, options } = await admittingNode();
    const adm = b64u(options.adm);
    const urls = [stranger.url, node.url];
    const dialing = dialRelay({ ...options, urls });
    // Every attempt, the fallback node's too, sends what the caller passed at the call.
    options.adm.fill(0);
    options.psk.fill(0);
    urls.length = 0;
    const session = await dialing;
    expect(stranger.closes).toEqual([4404]);
    expect(node.firstMessages).toEqual([{ t: "phone", v: 1, hid: b64u(HOST_ID), adm }]);
    for (const reply of await Promise.all([health(session), health(session)])) {
      expect(reply.startsWith("HTTP/1.1 200")).toBe(true);
      expect(reply).toContain('{"ok":true}');
    }
    expect(session.state).toBe("open");
    session.shutdown();
    expect(await session.closed).toBe(1000);
  });

  it("moves more than a stream window each way", async () => {
    const { node, options } = await admittingNode();
    const session = await dialRelay({ ...options, urls: [node.url] });
    const body = new Uint8Array(5 * 1024 * 1024 + 7);
    for (let offset = 0; offset < body.length; offset += 65_536) crypto.getRandomValues(body.subarray(offset, offset + 65_536));
    const sha256 = createHash("sha256").update(body).digest("hex");
    const [upload, download] = await Promise.all([
      request(session, `POST /upload HTTP/1.1\r\nHost: companion\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, body),
      request(session, `GET /bytes?n=${body.length} HTTP/1.1\r\nHost: companion\r\nConnection: close\r\n\r\n`),
    ]);
    expect(text(upload)).toContain(JSON.stringify({ bytes: body.length, sha256 }));
    expect(text(download.subarray(0, 12))).toBe("HTTP/1.1 200");
    const headEnd = download.findIndex((_, i) => download[i] === 13 && download[i + 1] === 10 && download[i + 2] === 13 && download[i + 3] === 10);
    expect(headEnd).toBeGreaterThan(0);
    const downloaded = download.subarray(headEnd + 4);
    expect(downloaded.length).toBe(body.length);
    expect(downloaded.every((byte, index) => byte === index % 251)).toBe(true);
    session.shutdown();
  });

  it("tries the next node on 4503 and on 4404, and keeps the last code when every node refuses", async () => {
    const full = await startNode();
    full.refuseWith = 4503;
    const stranger = await startNode();
    const { node, options } = await admittingNode();
    const session = await dialRelay({ ...options, urls: [full.url, stranger.url, node.url] });
    expect(full.closes).toEqual([4503]);
    expect(stranger.closes).toEqual([4404]);
    expect((await health(session)).startsWith("HTTP/1.1 200")).toBe(true);
    session.shutdown();

    const failure = dialRelay({ ...options, urls: [full.url, stranger.url] });
    await expect(failure).rejects.toBeInstanceOf(SessionClosed);
    await expect(failure).rejects.toMatchObject({ code: 4404 });
  });

  it("waits the delay a 4503 asks for before the next node", async () => {
    const full = await startNode();
    full.refuseWith = 4503;
    full.refuseReason = JSON.stringify({ retryInMs: 400 });
    const { node, options } = await admittingNode();
    const started = Date.now();
    const session = await dialRelay({ ...options, urls: [full.url, node.url] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    session.shutdown();
  });

  it("stops hard on a message 2 that fails to verify, even when the node closes 4404 meanwhile", async () => {
    const { node: closing, options } = await admittingNode();
    closing.computer = ready.wrongKey;
    closing.closeAfterFirst = 4404;
    const { node: next } = await admittingNode();
    await expect(dialRelay({ ...options, urls: [closing.url, next.url] })).rejects.toThrow("e2e: aead");
    expect(next.firstMessages).toEqual([]);
  });

  it("does not try another node after any other code", async () => {
    const strict = await startNode();
    strict.refuseWith = 4429;
    const { node, options } = await admittingNode();
    await expect(dialRelay({ ...options, urls: [strict.url, node.url] })).rejects.toMatchObject({ code: 4429 });
    expect(node.firstMessages).toEqual([]);
  });

  it("is refused with 4001 when the computer does not know the token", async () => {
    const { node, options } = await admittingNode();
    const wrong = await credentials("not-a-token-the-computer-knows");
    await expect(dialRelay({ ...options, psk: wrong.psk, urls: [node.url] })).rejects.toMatchObject({ code: 4001 });
  });

  it("gives up with 4002 when the handshake does not finish in time", async () => {
    const { node, options } = await admittingNode();
    node.stall = true;
    await expect(dialRelay({ ...options, urls: [node.url], timeoutMs: 200 })).rejects.toMatchObject({ code: 4002 });
  });

  it("closes the session with 1001 when a ping goes unanswered", async () => {
    const { node, options } = await admittingNode();
    const session = await dialRelay({ ...options, urls: [node.url], pingIntervalMs: 20, pingTimeoutMs: 100 });
    // Pings are answered while the path is alive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(session.state).toBe("open");
    node.mute = true;
    expect(await session.closed).toBe(1001);
  });
});

describe("dial: the direct route", () => {
  it("handshakes with the direct prologue and no pre-auth message", async () => {
    const { psk: key } = await credentials(ready.deviceToken);
    const session = await dial({ url: ready.direct, remoteStatic, psk: key, app: "web-test/1" });
    expect((await health(session)).startsWith("HTTP/1.1 200")).toBe(true);
    session.close(1000);
    expect(await session.closed).toBe(1000);
  });

  it("stops hard on a message 2 from a party without the key", async () => {
    const { psk: key } = await credentials(ready.deviceToken);
    await expect(dial({ url: ready.wrongKey, remoteStatic, psk: key, app: "web-test/1" })).rejects.toThrow("e2e: aead");
  });

  it("resets open streams when the session closes, and opens no more", async () => {
    const { psk: key } = await credentials(ready.deviceToken);
    const session = await dial({ url: ready.direct, remoteStatic, psk: key, app: "web-test/1" });
    const stream = session.open();
    const reader = stream.readable.getReader();
    await stream.write(utf8("GET /hang HTTP/1.1\r\nHost: companion\r\n\r\n"));
    expect(text((await reader.read()).value!)).toContain("data: start");
    session.close(1000);
    await expect(reader.read()).rejects.toThrow("stream reset");
    await expect(stream.write(utf8("more"))).rejects.toThrow("stream reset");
    expect(() => session.open()).toThrow(SessionClosed);
  });

  it("refuses writes once its FIN is sent, while the computer's half is still open", async () => {
    const { psk: key } = await credentials(ready.deviceToken);
    const session = await dial({ url: ready.direct, remoteStatic, psk: key, app: "web-test/1" });
    const stream = session.open();
    const reader = stream.readable.getReader();
    await stream.write(utf8("GET /hang HTTP/1.1\r\nHost: companion\r\n\r\n"));
    expect(text((await reader.read()).value!)).toContain("data: start");
    stream.end();
    await expect(stream.write(utf8("more"))).rejects.toThrow("stream ended");
    session.close(1000);
  });
});

/** A socket that records what the session sends, and records sealed and opened as themselves. */
function fakeSession(
  seal: (plaintext: Bytes) => Promise<Bytes> = async (plaintext) => plaintext,
  timers?: ConstructorParameters<typeof PhoneSession>[2],
) {
  const sent: Bytes[] = [];
  const closes: Array<number | undefined> = [];
  const socket = {
    bufferedAmount: 0,
    send: (record: Bytes) => sent.push(record.slice()),
    close: (code?: number) => closes.push(code),
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
  };
  const keys = { send: { seal }, receive: { open: async (record: Bytes) => record } } as unknown as SessionKeys;
  const session = new PhoneSession(socket as unknown as WebSocket, keys, timers);
  const record = (...bytes: number[]) => session.receive({ data: Uint8Array.from(bytes).buffer } as MessageEvent);
  const remoteClose = (code: number) => socket.onclose!({ code } as CloseEvent);
  return { session, sent, closes, record, remoteClose };
}

const GO_AWAY_REMOVED = [0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3];
const GO_AWAY_NORMAL = [0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const GO_AWAY_PROTOCOL = [0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
/** A WindowUpdate {SYN} on stream 2: the computer may not open streams. */
const COMPUTER_OPEN = [0, 1, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0];

describe("PhoneSession records and closes", () => {
  it("reads a GoAway(3) still being opened before the 4001 close behind it ends the session", async () => {
    const { session, record, remoteClose } = fakeSession();
    record(...GO_AWAY_REMOVED);
    remoteClose(4001);
    expect(await session.closed).toBe(4001);
    expect(session.removed).toBe(true);
  });

  it("sends GoAway(1) on a yamux violation before closing 4000", async () => {
    const { session, sent, closes, record } = fakeSession();
    record(...COMPUTER_OPEN);
    expect(await session.closed).toBe(4000);
    expect(sent).toEqual([Uint8Array.from(GO_AWAY_PROTOCOL)]);
    expect(closes).toEqual([4000]);
  });

  it("keeps a graceful close at 1000 when an unanswered ping times out while its GoAway is still being sealed", async () => {
    let release!: () => void;
    let calls = 0;
    const { session, sent, closes } = fakeSession(
      (plaintext) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(plaintext);
        return new Promise((resolve) => (release = () => resolve(plaintext)));
      },
      { pingIntervalMs: 10, pingTimeoutMs: 30 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    session.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 60));
    release();
    expect(await session.closed).toBe(1000);
    expect(sent.at(-1)).toEqual(Uint8Array.from(GO_AWAY_NORMAL));
    expect(closes).toEqual([1000]);
  });

  it("handles a seal that fails while an earlier one is pending, and keeps send order", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let release!: () => void;
      let calls = 0;
      const { session, sent } = fakeSession((plaintext) => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => (release = () => resolve(plaintext)));
        return Promise.reject(new Error("seal failed"));
      });
      const first = session.open();
      session.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      expect(await session.closed).toBe(4000);
      expect(sent).toHaveLength(1);
      expect(sent[0][7]).toBe(first.id);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
