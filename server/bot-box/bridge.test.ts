import { connect, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openBridge, parseBridgeArgs } from "./box-bridge.ts";
import { bridgedCommand, shellWord } from "./bridge.ts";

const bridges = [{ name: "egress", port: 3128, socket: "/x/egress.sock" }, { name: "harness", port: 8799, socket: "/x/harness.sock" }];

// The box runs only on a Linux Cloud home (detect.ts says "not-linux" anywhere else): the bridge is a POSIX shell
// inside it, over unix sockets at POSIX paths, and Windows has neither.
const linuxBox = describe.skipIf(process.platform === "win32");

linuxBox("the in-box bridge command", () => {
  it("with socat: a shell that starts one socat per bridge, waits for the first, then execs the engine with its argv untouched", () => {
    const { command, args } = bridgedCommand({ socat: "/usr/bin/socat", bridgeScript: "/app/box-bridge.js", node: "/usr/bin/node" }, bridges, "/usr/local/bin/claude", ["-p", "it's", "--x=1"]);
    expect(command).toBe("/bin/sh");
    expect(args[0]).toBe("-c");
    const script = args[1]!;
    expect(script).toContain("'/usr/bin/socat' TCP4-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:'/run/omb/egress.sock' </dev/null >/dev/null 2>&1 &");
    expect(script).toContain("'/usr/bin/socat' TCP4-LISTEN:8799,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:'/run/omb/harness.sock' </dev/null >/dev/null 2>&1 &");
    expect(script).toContain("TCP4:127.0.0.1:3128,connect-timeout=0.2");
    expect(script.trimEnd().endsWith('exec "$0" "$@"')).toBe(true);
    expect(args.slice(2)).toEqual(["/usr/local/bin/claude", "-p", "it's", "--x=1"]);
  });

  it("without socat: the bundled Node bridge, then the engine after --", () => {
    const { command, args } = bridgedCommand({ socat: null, bridgeScript: "/app/box-bridge.js", node: "/usr/bin/node" }, bridges, "claude", ["-p"]);
    expect(command).toBe("/usr/bin/node");
    expect(args).toEqual(["/app/box-bridge.js", "--bridge=3128=/run/omb/egress.sock", "--bridge=8799=/run/omb/harness.sock", "--", "claude", "-p"]);
    expect(parseBridgeArgs(args.slice(1))).toEqual({ bridges: [{ port: 3128, socket: "/run/omb/egress.sock" }, { port: 8799, socket: "/run/omb/harness.sock" }], command: ["claude", "-p"] });
  });

  it("no bridges (a shared-network box): the engine as is", () => {
    expect(bridgedCommand({ socat: "/usr/bin/socat", bridgeScript: "/b.js", node: "/n" }, [], "chrome", ["--headless"])).toEqual({ command: "chrome", args: ["--headless"] });
  });

  it("quotes a shell word", () => {
    expect(shellWord("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});

linuxBox("the Node bridge", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("pipes a loopback connection to the unix socket and back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-bridge-"));
    dirs.push(dir);
    const socketPath = join(dir, "u.sock");
    const echo = createServer((socket) => socket.on("data", (data) => socket.write(`echo:${data}`)));
    await new Promise<void>((resolve) => echo.listen(socketPath, resolve));
    const bridge = await openBridge({ port: 0, socket: socketPath });
    const port = (bridge.address() as { port: number }).port;
    const answer = await new Promise<string>((resolve, reject) => {
      const client = connect({ host: "127.0.0.1", port }, () => client.write("hi"));
      client.once("data", (data) => { resolve(String(data)); client.destroy(); });
      client.once("error", reject);
    });
    expect(answer).toBe("echo:hi");
    bridge.close();
    echo.close();
  });

  it("refuses a malformed argument", () => {
    expect(() => parseBridgeArgs(["--bridge=x"])).toThrow(/unexpected argument/);
  });
});
