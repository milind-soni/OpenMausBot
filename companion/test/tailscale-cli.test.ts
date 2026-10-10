import type { ExecFileOptions } from "node:child_process";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const standalone = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const fixture = vi.hoisted(() => ({
  output: "auto",
  fallback: false,
  calls: [] as Array<{ cli: string; args: string[]; options: ExecFileOptions }>,
}));

// Only synthetic network interfaces and an offline child may be reached.
// Keep real subprocess execution so losing the environment reproduces the bug.
vi.mock("node:child_process", async (original) => {
  const native = await original<typeof import("node:child_process")>();
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("./fixtures/tailscale-cli.mjs", import.meta.url));
  return {
    ...native,
    execFile(cli: string, args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) {
      fixture.calls.push({ cli, args, options });
      if (cli !== "/Applications/Tailscale.app/Contents/MacOS/Tailscale" && !(fixture.fallback && cli === "/usr/bin/tailscale")) {
        queueMicrotask(() => callback(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", ""));
        return;
      }
      return native.execFile(process.execPath, [script, ...args], {
        ...options,
        encoding: "utf8",
        env: { ...options.env, FAKE_TAILSCALE_OUTPUT: cli === "/usr/bin/tailscale" ? "auto" : fixture.output },
      }, callback);
    },
  };
});

vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  networkInterfaces: () => ({
    utun0: [{ family: "IPv4", internal: false, address: "100.64.0.7" }],
  }),
}));

import { createControlServer, type companionState } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { refreshTailnetName, tailnetName } from "../src/listener.ts";
import { tailscaleServe, tailscaleServeOff, tailscaleStatus } from "../../server/tailscale.ts";

let control: Server | undefined;

beforeEach(() => {
  fixture.calls = [];
  fixture.output = "auto";
  fixture.fallback = false;
  vi.stubEnv("PATH", "/usr/bin:/bin");
  for (const name of ["SHLVL", "TERM", "TERM_PROGRAM", "PS1"]) vi.stubEnv(name, undefined);
  // An inherited GUI preference must not override our explicit CLI request.
  vi.stubEnv("TAILSCALE_BE_CLI", "0");
});

afterEach(async () => {
  if (control) await new Promise<void>((resolve) => control!.close(() => resolve()));
  control = undefined;
  vi.unstubAllEnvs();
});

describe("Tailscale from a shell-less standalone macOS app", () => {
  it("refreshes the real control endpoint and advertises HTTP on the companion port", async () => {
    fixture.output = "gui";
    const attempts: string[] = [];
    await refreshTailnetName((_cli, outcome) => attempts.push(outcome));
    expect(tailnetName()).toBeNull();
    expect(attempts[0]).toBe("exited successfully in GUI mode instead of CLI mode");
    expect(attempts.join("\n")).not.toContain("private diagnostic");

    fixture.output = "auto";
    fixture.calls = [];
    control = createControlServer({
      devices: new DeviceRegistry(),
      companionPort: 8787,
      discovery: () => ({ advertising: false, name: "Fixture" }),
      hostedUrl: () => "https://fixture.openmausbot.com",
      refreshTailscale: () => refreshTailnetName(),
    });
    await new Promise<void>((resolve) => control!.listen(0, "127.0.0.1", resolve));
    const { port } = control.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/tailscale/refresh`, { method: "POST" });
    const state = await response.json() as ReturnType<typeof companionState>;
    expect(response.status).toBe(200);
    expect(state.tailnetName).toBe("fixture.tail1234.ts.net");
    expect(state.endpoints).toContainEqual({ url: "http://fixture.tail1234.ts.net:8787", kind: "tailnet", priority: 100 });
    expect(state.endpoints).toContainEqual({ url: "https://fixture.openmausbot.com", kind: "hosted", priority: 0 });
    expect(state.endpoints.some((endpoint: { url: string }) => endpoint.url.includes("100.64.0.7"))).toBe(false);
    expect(state.pairing).toBeNull();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].cli).toBe(standalone);
    expect(fixture.calls[0].options.env?.TAILSCALE_BE_CLI).toBe("1");
    expect(process.env.TAILSCALE_BE_CLI).toBe("0");
  });

  it("keeps trying installed CLI paths after a successful GUI-only exit", async () => {
    fixture.output = "gui";
    fixture.fallback = true;
    await refreshTailnetName();
    expect(tailnetName()).toBe("fixture.tail1234.ts.net");
    expect(fixture.calls.at(-1)?.cli).toBe("/usr/bin/tailscale");
  });

  it.each([
    ["invalid", "exited successfully, but status output was not JSON"],
    ["no-dns", "ran, but no MagicDNS name in status"],
  ])("distinguishes %s from GUI mode and clears stale names", async (output, expected) => {
    await refreshTailnetName();
    expect(tailnetName()).not.toBeNull();
    fixture.output = output;
    const attempts: string[] = [];
    await refreshTailnetName((_cli, outcome) => attempts.push(outcome));
    expect(tailnetName()).toBeNull();
    expect(attempts[0]).toBe(expected);
    expect(attempts.join("\n")).not.toContain("private diagnostic");
  });

  it("also forces CLI mode for self-hosted status, HTTPS Serve, and Serve off", async () => {
    const result = await tailscaleStatus();
    expect(result).toHaveProperty("status");
    if (!("status" in result)) throw new Error("fixture CLI not found");
    expect(await tailscaleServe(result.status, 8799)).toEqual({ origin: "https://fixture.tail1234.ts.net" });
    await tailscaleServeOff(result.status);
    expect(fixture.calls.map(({ args }) => args)).toEqual([
      ["status", "--json"],
      ["serve", "--bg", "--https=443", "http://127.0.0.1:8799"],
      ["serve", "--https=443", "off"],
    ]);
    expect(fixture.calls.every(({ options }) => options.env?.TAILSCALE_BE_CLI === "1" && !options.shell)).toBe(true);
  });
});
