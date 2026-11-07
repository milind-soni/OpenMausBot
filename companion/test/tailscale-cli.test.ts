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
  it("also forces CLI mode for self-hosted status, HTTPS Serve, and Serve off", async () => {
    const result = await tailscaleStatus();
    expect(result).toHaveProperty("status");
    if (!("status" in result)) throw new Error("fixture CLI not found");
    expect(await tailscaleServe(result.status, 8799)).toEqual({ origin: "https://fixture.tail1234.ts.net" });
    await tailscaleServeOff(result.status);
    const ran = fixture.calls.filter(({ cli }) => cli === standalone);
    expect(ran.map(({ args }) => args)).toEqual([
      ["status", "--json"],
      ["serve", "--bg", "--https=443", "http://127.0.0.1:8799"],
      ["serve", "--https=443", "off"],
    ]);
    expect(ran.every(({ options }) => options.env?.TAILSCALE_BE_CLI === "1" && !options.shell)).toBe(true);
  });
});
