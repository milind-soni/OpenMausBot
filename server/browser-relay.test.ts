import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { RelayPorts, RelayTimeout, captureFrame, relay, relayTarget, typeText } from "./browser-relay.ts";
import { FakeRelay } from "./testing/fake-relay.ts";

const relays: FakeRelay[] = [];
async function fake(session = "bot-test") {
  const value = await new FakeRelay(session).start();
  relays.push(value);
  return value;
}
afterEach(async () => { await Promise.all(relays.splice(0).map((value) => value.close())); });

describe("the engine's loopback command relay", () => {
  it("posts one same-origin command, reports a launch, and refuses redirects", async () => {
    const daemon = await fake();
    daemon.launchNext = true;
    const answer = await relay(daemon.port, { action: "console" }, { timeoutMs: 1_000 });
    expect(answer).toMatchObject({ success: true, launched: true, data: { messages: [] } });
    // The fake answers 403 to a request without the same-origin header, as the engine does.
    expect(daemon.commands).toEqual([{ action: "console" }]);
    const redirecting = createServer((req, res) => {
      if (req.url === "/api/command") { res.writeHead(307, { location: "/elsewhere" }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { messages: [] } }));
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    try {
      await expect(relay((redirecting.address() as { port: number }).port, { action: "console" }, { timeoutMs: 1_000 })).rejects.toThrow();
    } finally { await new Promise((resolve) => redirecting.close(resolve)); }
  });

  it("caps an answer's size and times out a daemon that does not answer", async () => {
    const daemon = await fake();
    daemon.console = Array.from({ length: 2_000 }, (_, index) => ({ type: "log", text: `line ${index} ${"x".repeat(100)}` }));
    await expect(relay(daemon.port, { action: "console" }, { timeoutMs: 1_000, maxBytes: 10_000 })).rejects.toThrow(/too large/);
    daemon.hang.add("errors");
    await expect(relay(daemon.port, { action: "errors" }, { timeoutMs: 100 })).rejects.toBeInstanceOf(RelayTimeout);
  });

  it("finds the port in the daemon's .stream file, and trusts it only for a daemon that names this session", async () => {
    const daemon = await fake("bot-a");
    const ports = new RelayPorts();
    expect(await ports.port(daemon.target)).toBe(daemon.port);
    expect(daemon.actions()).toEqual(["session_info"]);
    expect(await ports.port(daemon.target)).toBe(daemon.port);
    expect(daemon.actions()).toEqual(["session_info"]);
    const other = await fake("bot-b");
    other.writeStreamFile();
    const stranger = new RelayPorts();
    other.sessionName = "bot-someone-else";
    expect(await stranger.port(other.target)).toBeNull();
    daemon.removeStreamFile();
    const before = daemon.commands.length;
    expect(await ports.port(daemon.target)).toBeNull();
    expect(daemon.commands.length).toBe(before);
  });

  it("asks again once the daemon it confirmed has died, so a port another bot's daemon took over is never typed into or pictured", async () => {
    const daemon = await fake("bot-a");
    const alive = new Set([daemon.daemonPid]);
    const ports = new RelayPorts({ alive: (pid) => alive.has(pid) });
    expect(await ports.port(daemon.target)).toBe(daemon.port);
    // bot-a's daemon crashed and left its .stream file; bot-b's daemon now listens on that port.
    alive.delete(daemon.daemonPid);
    daemon.sessionName = "bot-b";
    daemon.daemonPid = 5151;
    alive.add(5151);
    expect(await ports.port(daemon.target)).toBeNull();
    await expect(captureFrame(ports, daemon.target)).rejects.toThrow(/no open page/);
    await expect(typeText(ports, daemon.target, "fake-S3cret!")).rejects.toThrow();
    expect(daemon.typed).toEqual([]);
    expect(daemon.actions().filter((action) => action === "screenshot" || action === "keyboard")).toEqual([]);
  });

  it("takes a daemon too busy to confirm its session as unknown, not absent", async () => {
    const daemon = await fake();
    daemon.hang.add("session_info");
    const ports = new RelayPorts();
    expect(await ports.probe(daemon.target)).toBeNull();
    expect(ports.isTripped(daemon.session)).toBe(true);
  });

  it("probes whether Chrome is connected, and leaves a session alone after a timeout until a probe answers", async () => {
    const daemon = await fake();
    const ports = new RelayPorts();
    expect(await ports.probe(daemon.target)).toEqual({ port: daemon.port, connected: true });
    daemon.connected = false;
    expect(await ports.probe(daemon.target)).toEqual({ port: daemon.port, connected: false });
    daemon.hang.add("stream_status");
    expect(await ports.probe(daemon.target)).toBeNull();
    expect(ports.isTripped(daemon.session)).toBe(true);
    daemon.hang.clear();
    daemon.connected = true;
    expect(await ports.probe(daemon.target)).toEqual({ port: daemon.port, connected: true });
    expect(ports.isTripped(daemon.session)).toBe(false);
  });
});

describe("preview frames over the relay", () => {
  it("returns the picture the daemon wrote, and leaves no file behind", async () => {
    const daemon = await fake();
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("openmausbot-browser-")).length;
    const frame = await captureFrame(new RelayPorts(), daemon.target);
    expect(frame.format).toBe("jpeg");
    expect(Buffer.from(frame.png, "base64")).toEqual(daemon.picture);
    expect(daemon.commands.find((command) => command.action === "screenshot")).toMatchObject({ format: "jpeg", quality: 80 });
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("openmausbot-browser-")).length).toBe(before);
  });

  it("never starts a browser: no daemon, or a Chrome that is not connected, gives no frame and sends no capture", async () => {
    const daemon = await fake();
    daemon.connected = false;
    await expect(captureFrame(new RelayPorts(), daemon.target)).rejects.toThrow(/no open page/);
    daemon.removeStreamFile();
    await expect(captureFrame(new RelayPorts(), daemon.target)).rejects.toThrow(/no open page/);
    expect(daemon.actions().every((action) => action === "stream_status" || action === "session_info")).toBe(true);
  });

  it("fails rather than inventing a picture the daemon did not take", async () => {
    const daemon = await fake();
    daemon.picture = null;
    await expect(captureFrame(new RelayPorts(), daemon.target)).rejects.toThrow(/could not be pictured/);
  });

  it("notes a Chrome that died between the probe and the picture and was started again, for the bot's next call", async () => {
    const daemon = await fake();
    const ports = new RelayPorts();
    await captureFrame(ports, daemon.target);
    expect(ports.takeStarted(daemon.session)).toBe(false);
    daemon.launchNext = true; // the screenshot found Chrome gone and the engine started it
    await captureFrame(ports, daemon.target);
    expect(ports.takeStarted(daemon.session)).toBe(true);
    expect(ports.takeStarted(daemon.session)).toBe(false);
    ports.noteStarted(daemon.session);
    ports.forget(daemon.session); // a close or restart: nothing of the old browser carries over
    expect(ports.takeStarted(daemon.session)).toBe(false);
  });
});

describe("a session's relay address", () => {
  it("names the session, keeps its own socket folder, and carries none of the server's credentials", () => {
    process.env.ANTHROPIC_API_KEY_FOR_RELAY_TEST = "fake-provider-key";
    try {
      const target = relayTarget({ command: "/bin/agent-browser", env: { AGENT_BROWSER_SOCKET_DIR: "/tmp/sockets" } }, "bot-a");
      expect(target).toMatchObject({ session: "bot-a", binaryPath: "/bin/agent-browser", env: { AGENT_BROWSER_SESSION: "bot-a", AGENT_BROWSER_SOCKET_DIR: "/tmp/sockets" } });
      expect(JSON.stringify(target)).not.toContain("fake-provider-key");
    } finally { delete process.env.ANTHROPIC_API_KEY_FOR_RELAY_TEST; }
  });
});

describe("typing over the relay", () => {
  it("types the text into the focused field through the session's own relay", async () => {
    const daemon = await fake();
    await typeText(new RelayPorts(), daemon.target, "fake-S3cret!");
    expect(daemon.typed).toEqual(["fake-S3cret!"]);
    expect(daemon.commands).toEqual([{ action: "session_info" }, { action: "keyboard", subaction: "insertText", text: "fake-S3cret!" }]);
  });
});
