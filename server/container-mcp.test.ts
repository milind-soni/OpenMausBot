import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CONTAINER, CUA_EXECUTABLE, CUA_SOCKET } from "./container-computer.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// The fake Docker executable below is a POSIX shell script. The production
// bridge remains portable; only this byte-for-byte process fixture is gated.
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Local VM Cua MCP bridge", () => {
  it("passes MCP bytes unchanged to cua-driver mcp over the container runtime", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openmausbot-container-mcp-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    await writeFile(
      fakeDocker,
      "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\" >&2\ncat\n",
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);

    const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
        {
          env: { ...process.env, OMB_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toContain(
      `ARGS:exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
        `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ` +
        `${CUA_EXECUTABLE} mcp --socket ${CUA_SOCKET}`,
    );
  });

  it("answers ping locally so the bundled cua-driver is not invoked", async () => {
    const bin = await mkdtemp(join(tmpdir(), "openmausbot-container-mcp-ping-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    await writeFile(
      fakeDocker,
      `#!/bin/sh\n` +
        `printf 'ARGS:%s\\n' "$*" >&2\n` +
        `while IFS= read -r line; do\n` +
        `  case "$line" in\n` +
        `    *'"method":"ping"'* ) printf 'PING-RECEIVED:%s\\n' "$line" >&2 ;;\n` +
        `    *'"method":"tools/list"'* ) printf '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\\n' ;;\n` +
        `  esac\n` +
        `done\n`,
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);

    const input =
      '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}\n' +
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
        {
          env: { ...process.env, OMB_EXTRA_PATH: bin, NODE_NO_WARNINGS: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: 2, result: {} },
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    ]);
    expect(result.stderr).not.toContain("PING-RECEIVED");
    expect(result.stderr).toContain(
      `ARGS:exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
        `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ` +
        `${CUA_EXECUTABLE} mcp --socket ${CUA_SOCKET}`,
    );
  });
});
