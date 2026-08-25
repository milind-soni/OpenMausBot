import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUA_DRIVER_VERSION } from "./container-computer.ts";
import {
  existingVmComputerMcp,
  existingVmLivenessArgs,
  existingVmMcpArgs,
  existingVmScreenshot,
  existingVmStatus,
  closeExistingVmScreenshotSessions,
  type ExistingVmOptions,
} from "./existing-vm.ts";
import type { AppConfig } from "./config.ts";
import { validPngFixture } from "./testing/png-fixture.ts";

const FIXED_SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
];

const validPng = validPngFixture();
const malformedPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);
const fakeSshSource = String.raw`import { appendFileSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const args = process.argv.slice(2);
const alias = args[9];
const remote = args.slice(10).join(" ");
const validImage = Buffer.from(${JSON.stringify(validPng.toString("base64"))}, "base64");
const malformedImage = Buffer.from(${JSON.stringify(malformedPng.toString("base64"))}, "base64");

const trace = process.env.EXISTING_VM_TEST_TRACE;
const traceNumber = trace && remote === "cua-driver mcp"
  ? readFileSync(trace, "utf8").split("\n").filter(Boolean).length + 1
  : 0;
if (trace && remote === "cua-driver mcp") appendFileSync(trace, alias + "\n");

if (alias === "vm-unreachable") {
  process.stderr.write("Connection refused\n");
  process.exit(255);
}
if (alias === "vm-overflow" && remote === "cua-driver mcp") {
  process.stdout.write("x".repeat(2048));
  setInterval(() => {}, 1000);
} else if (alias === "vm-invalid-json" && remote === "cua-driver mcp") {
  process.stdout.write("not-json\n");
  setInterval(() => {}, 1000);
} else if (alias === "vm-timeout") {
  setInterval(() => {}, 1000);
} else if (remote === "uname -s") {
  const output = alias === "vm-windows" ? "Windows_NT\n" : "Linux\n";
  if (alias === "vm-slow") setTimeout(() => { process.stdout.write(output); process.exit(0); }, 30);
  else {
    process.stdout.write(output);
    process.exit(0);
  }
} else if (remote === "cua-driver --version") {
  process.stdout.write(alias === "vm-bad-version" ? "cua-driver 0.19.0\n" : "cua-driver 0.20.0\n");
  process.exit(0);
} else if (remote !== "cua-driver mcp") process.exit(2);

const tools = ["get_desktop_state", "list_apps", "click", "type_text", "press_key", "scroll"];
if (alias === "vm-missing-tool") tools.pop();
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05" };
    else if (message.method === "tools/list") result = { tools: tools.map((name) => ({ name })) };
    else if (message.method === "tools/call" && alias === "vm-no-image") result = { content: [{ type: "text", text: "no image" }] };
    else if (message.method === "tools/call") {
      const image = alias === "vm-invalid-image" || (alias === "vm-session-failure" && traceNumber % 2 === 0)
        ? malformedImage
        : validImage;
      result = { content: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] };
    }
    else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
`;

describe("Existing VM transport", () => {
  let temp: string;
  let fakeSsh: string;
  let options: ExistingVmOptions;

  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), "openmausbot-existing-vm-"));
    fakeSsh = join(temp, "fake-ssh.mjs");
    writeFileSync(fakeSsh, fakeSshSource, "utf8");
    options = { sshCommand: process.execPath, sshCommandPrefix: [fakeSsh] };
  });

  afterAll(() => {
    closeExistingVmScreenshotSessions();
    rmSync(temp, { recursive: true, force: true });
  });

  const config = (sshAlias: string): AppConfig => ({ localVm: { source: "existing", sshAlias } });

  it("uses a fixed SSH command and rejects shell-like aliases", () => {
    expect(existingVmMcpArgs("my-vm")).toEqual([...FIXED_SSH_OPTIONS, "my-vm", "cua-driver", "mcp"]);
    expect(existingVmLivenessArgs("my-vm")).toEqual([...FIXED_SSH_OPTIONS, "my-vm", "true"]);
    expect(() => existingVmMcpArgs("vm; reboot")).toThrow("invalid Existing VM SSH config alias");
    expect(() => existingVmLivenessArgs("$(id)")).toThrow("invalid Existing VM SSH config alias");
  });

  it("requires Linux, the pinned driver, MCP tools, and a complete desktop image", async () => {
    const status = await existingVmStatus(config("vm-good"), options);

    expect(status).toMatchObject({
      source: "existing",
      configured: true,
      ssh: "connected",
      os: "linux",
      driver: "compatible",
      mcp: "ready",
      desktopReady: true,
      ready: true,
      driver_version: CUA_DRIVER_VERSION,
      viewer_url: "",
      watch_only: true,
    });
    expect(status.tools).toEqual(expect.arrayContaining(["get_desktop_state", "click", "type_text", "press_key", "scroll"]));
    expect(status).not.toHaveProperty("mode");
    expect(status).not.toHaveProperty("max_instances");

    const frame = await existingVmScreenshot(config("vm-good"), options);
    expect(frame.format).toBe("png");
    expect(frame.png).toBeTruthy();
  });

  it("rejects a PNG-shaped response with invalid chunk structure", async () => {
    const status = await existingVmStatus(config("vm-invalid-image"), options);
    expect(status.ready).toBe(false);
    expect(status.errorCode).toBe("desktop");
  });

  it("reuses and recreates the bounded screenshot MCP session", async () => {
    const trace = join(temp, "screenshot-trace.log");
    writeFileSync(trace, "", "utf8");
    process.env.EXISTING_VM_TEST_TRACE = trace;
    const sessionOptions = { ...options, screenshotSessionIdleMs: 5_000 };
    try {
      await existingVmScreenshot(config("vm-reusable"), sessionOptions);
      await existingVmScreenshot(config("vm-reusable"), sessionOptions);
      const reusedCount = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length;
      expect(reusedCount).toBe(3);

      await new Promise((resolve) => setTimeout(resolve, 5_100));
      await existingVmScreenshot(config("vm-reusable"), sessionOptions);
      const recreatedCount = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length;
      expect(recreatedCount).toBe(5);
    } finally {
      delete process.env.EXISTING_VM_TEST_TRACE;
      closeExistingVmScreenshotSessions();
    }
  });

  it("recreates a screenshot session after a transport or image failure", async () => {
    const trace = join(temp, "failure-trace.log");
    writeFileSync(trace, "", "utf8");
    process.env.EXISTING_VM_TEST_TRACE = trace;
    try {
      await expect(existingVmScreenshot(config("vm-session-failure"), options)).rejects.toThrow();
      await expect(existingVmScreenshot(config("vm-session-failure"), options)).rejects.toThrow();
      const count = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length;
      expect(count).toBe(4);
    } finally {
      delete process.env.EXISTING_VM_TEST_TRACE;
      closeExistingVmScreenshotSessions();
    }
  });

  it("closes an MCP client after output-limit overflow", async () => {
    const status = await existingVmStatus(config("vm-overflow"), { ...options, mcpLineLimit: 64 });
    expect(status.errorCode).toBe("mcp");
    expect(status.problem).toContain("output limit");
  });

  it("closes an MCP client after invalid JSON", async () => {
    const status = await existingVmStatus(config("vm-invalid-json"), options);
    expect(status.errorCode).toBe("mcp");
    expect(status.problem).toContain("invalid JSON");
  });

  it("deduplicates simultaneous forced readiness probes", async () => {
    const trace = join(temp, "force-trace.log");
    writeFileSync(trace, "", "utf8");
    process.env.EXISTING_VM_TEST_TRACE = trace;
    try {
      const forced = { ...options, cacheStatus: true, force: true };
      await Promise.all([existingVmStatus(config("vm-slow"), forced), existingVmStatus(config("vm-slow"), forced)]);
      const count = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length;
      expect(count).toBe(1);
    } finally {
      delete process.env.EXISTING_VM_TEST_TRACE;
      closeExistingVmScreenshotSessions();
    }
  });

  it("distinguishes a missing SSH executable, an unreachable VM, and a timeout", async () => {
    const missing = await existingVmStatus(config("vm-missing-ssh"), {
      sshCommand: join(temp, "ssh-not-installed"),
    });
    expect(missing.errorCode).toBe("ssh-missing");
    expect(missing.problem).toContain("OpenSSH (ssh) is not installed");

    const unreachable = await existingVmStatus(config("vm-unreachable"), options);
    expect(unreachable.errorCode).toBe("ssh-unreachable");

    const timedOut = await existingVmStatus(config("vm-timeout"), { ...options, sshTimeoutMs: 20 });
    expect(timedOut.errorCode).toBe("timeout");
  });

  it.each([
    ["vm-windows", "unsupported", "remote-os"],
    ["vm-bad-version", "incompatible", "cua-version"],
    ["vm-missing-tool", "failed", "mcp"],
    ["vm-no-image", "failed", "desktop"],
  ] as const)("reports the failing readiness stage for %s", async (alias, stage, errorCode) => {
    const status = await existingVmStatus(config(alias), options);
    expect(status.ready).toBe(false);
    if (stage === "unsupported") expect(status.os).toBe(stage);
    if (stage === "incompatible") expect(status.driver).toBe(stage);
    if (stage === "failed") expect(status.mcp).toBe(stage);
    expect(status.errorCode).toBe(errorCode);
  });

  it("does not expose a viewer or a managed lifecycle through the MCP spawn contract", () => {
    const mcp = existingVmComputerMcp(config("my-vm"));
    expect(mcp.command).toBe(process.execPath);
    expect(mcp.args.at(-1)).toBe("my-vm");
    expect(mcp.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });
});
