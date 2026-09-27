import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_BRANDING_SCRIPT, DESKTOP_HOSTNAME } from "./desktop-branding.ts";
import { CONTAINER, containerRunArgs, cuaExecArgs, perBotLocalVmTarget } from "./container-computer.ts";
import { vpsContainerName, vpsContainerRunArgs } from "./vps-computer.ts";

const roots: string[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), "nation-terminal-")); roots.push(path); return path; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("uses a NATION hostname without orphaning existing shared, per-bot or VPS containers", () => {
  const bot = perBotLocalVmTarget("alice");
  const vps = vpsContainerName("alice");
  for (const [name, args] of [
    [CONTAINER, containerRunArgs("docker")], [bot.containerName, containerRunArgs("podman", "fixture", bot)],
    [vps, vpsContainerRunArgs(vps)],
  ] as const) {
    expect(args[args.indexOf("--hostname") + 1]).toBe("nation-computer");
    expect(args[args.indexOf("--name") + 1]).toBe(name);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("SYS_ADMIN");
  }
  expect(DESKTOP_HOSTNAME).not.toMatch(/open.?muse|openmaus/i);
});

it("repairs before MCP/viewing, under the existing guest user, while status remains read-only", () => {
  for (const args of [cuaExecArgs(["mcp"]), cuaExecArgs(["call", "get_desktop_state", "{}"], { brandDesktop: true })]) {
    expect(args).toContain(DESKTOP_BRANDING_SCRIPT);
    expect(args.slice(0, 3)).toEqual(["exec", "-u", "cua"]);
  }
  expect(cuaExecArgs(["call", "get_desktop_state", "{}"]).includes(DESKTOP_BRANDING_SCRIPT)).toBe(false);
});

describe.skipIf(process.platform === "win32")("real guest shell presentation in an isolated home", () => {
  it.each(["string", "array"])("repairs legacy prompts and titles, preserving %s prompt callbacks and saved files", kind => {
    const root = home();
    const rc = join(root, ".bashrc");
    const original = String.raw`PS1='CUSTOM \u@\h (openmausbot-computer):\w\$ '
custom_prompt() { printf 'CUSTOM_CALLBACK'; }
` + (kind === "array" ? "PROMPT_COMMAND=(custom_prompt)\n" : "PROMPT_COMMAND=custom_prompt\n");
    writeFileSync(rc, original);
    writeFileSync(join(root, "saved-work.txt"), "preserve this work");
    writeFileSync(join(root, ".bash_history"), "preserve history\n");
    const env = { ...process.env, HOME: root, TERM: "xterm", HOSTNAME: "openmausbot-computer" };
    const install = () => execFileSync("sh", ["-c", DESKTOP_BRANDING_SCRIPT, "nation-desktop", "true"], { env, encoding: "utf8" });
    expect(install()).toBe("");
    const installed = readFileSync(rc, "utf8");
    expect(install()).toBe("");
    expect(readFileSync(rc, "utf8")).toBe(installed);
    expect(installed.startsWith(original)).toBe(true);
    const output = execFileSync("bash", ["--noprofile", "--rcfile", rc, "-ic",
      'printf "PROMPT:%s\\n" "${PS1@P}"; for cmd in "${PROMPT_COMMAND[@]}"; do eval "$cmd"; done'], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(output).toContain("NATION Computer");
    expect(output).toContain("nation-computer");
    expect(output).toContain("CUSTOM");
    expect(output).toContain("CUSTOM_CALLBACK");
    expect(output).not.toMatch(/open.?muse|openmaus/i);
    expect(readFileSync(join(root, "saved-work.txt"), "utf8")).toBe("preserve this work");
    expect(readFileSync(join(root, ".bash_history"), "utf8")).toBe("preserve history\n");
  });

  it("preserves MCP bytes, arguments, exit code and umask when launching the real child", () => {
    const root = home();
    const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    const child = 'const fs = require("node:fs"); if (process.argv[1] !== "space ; $HOME") process.exit(2); process.stdout.write(fs.readFileSync(0));';
    const stdout = execFileSync("sh", ["-c", DESKTOP_BRANDING_SCRIPT, "nation-desktop", process.execPath, "-e", child, "space ; $HOME"],
      { env: { ...process.env, HOME: root }, input, encoding: "utf8" });
    expect(stdout).toBe(input);
    const mask = execFileSync("sh", ["-c", "umask"], { encoding: "utf8" });
    expect(execFileSync("sh", ["-c", DESKTOP_BRANDING_SCRIPT, "nation-desktop", "sh", "-c", "umask"],
      { env: { ...process.env, HOME: home() }, encoding: "utf8" })).toBe(mask);
    try {
      execFileSync("sh", ["-c", DESKTOP_BRANDING_SCRIPT, "nation-desktop", "sh", "-c", "exit 23"], { env: { ...process.env, HOME: root } });
      expect.unreachable();
    } catch (error) { expect((error as { status: number }).status).toBe(23); }
  });
});
