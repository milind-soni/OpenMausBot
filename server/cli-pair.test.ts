import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPair, type CliOptions } from "./cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const mocks = vi.hoisted(() => ({
  readCliStartup: vi.fn(),
  createTunnelAccount: vi.fn(), describeTunnelAccount: vi.fn(), tailscaleStatus: vi.fn(),
  ui: { log: vi.fn(), choose: vi.fn(), ask: vi.fn(), secret: vi.fn(), confirm: vi.fn() },
}));
vi.mock("./cli-setup.ts", () => ({ readCliStartup: mocks.readCliStartup }));
vi.mock("./cli-prompts.ts", async (original) => ({
  ...await original<typeof import("./cli-prompts.ts")>(), defaultSetupIo: () => mocks.ui,
}));
vi.mock("./tailscale.ts", () => ({
  tailscaleStatus: mocks.tailscaleStatus,
  tailscaleServe: vi.fn(), clearLeftoverTailscaleServe: vi.fn(), explainTailscaleFailure: vi.fn(),
}));
vi.mock("./tunnel.ts", () => ({
  createTunnelAccount: mocks.createTunnelAccount, describeTunnelAccount: mocks.describeTunnelAccount,
  cleanupTunnelOrigin: vi.fn(), createTunnelOrigin: vi.fn(), describeTunnelState: vi.fn(),
  ensureCloudflared: vi.fn(), guardianEntry: vi.fn(), startTunnel: vi.fn(), tunnelAccess: vi.fn(),
}));

const advertisedOrigin = "https://current.example.test";
const explicitOrigin = "https://override.example.test";
const workspaceId = "4e406646-1030-4613-8878-e227ab722ffc";
const code = "ABCD-EFGH-JKLM";
const ttyDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
let dataDir: string;
let options: CliOptions;
let publicUrl: string | null;
let remoteWorkspaceId: string;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  // The shared test setup supplies a throwaway HOME before module imports.
  dataDir = mkdtempSync(join(process.env.HOME!, "cli-pair-"));
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  options = { command: "pair", port: 18451, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false };
  publicUrl = advertisedOrigin;
  remoteWorkspaceId = workspaceId;
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  mocks.ui.choose.mockResolvedValue(0);
  mocks.createTunnelAccount.mockReturnValue({ credentials: { read: () => ({}) } });
  mocks.describeTunnelAccount.mockReturnValue({ address: "https://old-tunnel.example.test", email: "fixture@example.test" });
  mocks.tailscaleStatus.mockResolvedValue({ status: { dnsName: "old-tailnet.example.test" } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const local = `http://127.0.0.1:${options.port}`;
    if (url === `${local}/api/health`) return Response.json({ app: "openmausbot", pid: 12345 });
    if (url === `${local}/api/auth/pairing`) {
      if (init?.method === "POST") return Response.json({ code, expiresAt: Date.now() + 300_000, url: `${advertisedOrigin}/pair#code=${code}` });
      return Response.json({ pairings: [], publicUrl });
    }
    if (url === `${local}/.well-known/openmausbot/environment`) return Response.json({ environmentId: workspaceId });
    if ([advertisedOrigin, explicitOrigin].some((origin) => url === `${origin}/.well-known/openmausbot/environment`)) {
      return Response.json({ environmentId: remoteWorkspaceId });
    }
    // No real network fallback is allowed, including stale saved addresses.
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [index, stream] of [process.stdin, process.stdout].entries()) {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  await removeTempDir(dataDir);
});

const printed = () => vi.mocked(console.log).mock.calls.map(([line]) => String(line)).join("\n");

describe("openmausbot pair", () => {
  it("never asks anything: one code, the running server's own link, a QR, and the phone command", async () => {
    expect(await runPair(options)).toBe(0);
    expect(mocks.ui.choose).not.toHaveBeenCalled();
    expect(mocks.readCliStartup).not.toHaveBeenCalled();
    expect(mocks.tailscaleStatus).not.toHaveBeenCalled();
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted![1]!.body))).toEqual({});
    expect(printed()).toMatch(new RegExp(`Pairing code {3}${code} {3}works once, until .+ · everything`));
    expect(printed()).toContain(`Link           ${advertisedOrigin}/pair#code=${code}`);
    expect(printed()).toMatch(/[▀▄█]/);
    expect(printed()).toContain("For a phone (chat and approvals only)   openmausbot pair --phone");
    expect(printed()).not.toContain("doesn't reach");
  });

  it("an explicit --public-url wins over the advertised address", async () => {
    expect(await runPair({ ...options, publicUrl: explicitOrigin })).toBe(0);
    expect(printed()).toContain(`Link           ${explicitOrigin}/pair#code=${code}`);
  });

  it("--phone mints a chat-only code", async () => {
    expect(await runPair({ ...options, phone: "ios" })).toBe(0);
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted![1]!.body))).toEqual({ scopes: ["client"] });
    expect(printed()).toContain("· chat and approvals");
    expect(printed()).not.toContain("For a phone");
  });

  it("still prints the code when the address answers as another server, and says what to fix", async () => {
    remoteWorkspaceId = "another-workspace";
    expect(await runPair(options)).toBe(0);
    expect(printed()).toContain(`Link           ${advertisedOrigin}/pair#code=${code}`);
    expect(printed()).toContain(`✗ ${advertisedOrigin} answers as a different server.`);
    expect(printed()).toContain("The code works once the address answers.");
  });

  it("with no way in: the browser on this machine, and the command that lists the ways in", async () => {
    publicUrl = null;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ app: "openmausbot", pid: 12345 });
      if (url.endsWith("/api/auth/pairing")) return init?.method === "POST" ? Response.json({ code, expiresAt: Date.now() + 600_000, url: null }) : Response.json({ pairings: [], publicUrl: null });
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    expect(await runPair(options)).toBe(0);
    expect(printed()).toContain(`http://127.0.0.1:${options.port}/pair#code=${code}`);
    expect(printed()).toContain("pick a way in first: openmausbot serve --help");
    expect(printed()).not.toMatch(/[▀▄█]/);
  });

  it("when the desktop app owns the server, says to pair from the app instead of showing the raw refusal", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ app: "openmausbot", pid: 12345 });
      if (url.endsWith("/api/auth/pairing")) {
        return init?.method === "POST"
          ? Response.json({ error: "forbidden: this change must come from the desktop app or a paired device" }, { status: 403 })
          : Response.json({ pairings: [], publicUrl: null });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const failure = await runPair(options).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("The OpenMausBot desktop app runs this server");
    expect(message).toContain("Settings → Remote access");
    // A terminal `serve` would not get the keys the app keeps in its own credential store, so it is not offered.
    expect(message).not.toContain("openmausbot serve");
    expect(message).not.toContain("server refused to mint a pairing code");
  });

  it("says how to start a server when none runs", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("offline"); });
    expect(await runPair(options)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No MausBot server is running here. Start it: openmausbot serve"));
  });
});

describe("the phone-app link `openmausbot pair --phone android` scans", () => {
  const credential = `omb_pair_${"b".repeat(43)}`;
  const serverName = "Miguel's computer";
  const pairingResponse = (fields: Record<string, unknown>) => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `http://127.0.0.1:${options.port}/api/health`) return Response.json({ app: "openmausbot", pid: 12345 });
      if (url === `http://127.0.0.1:${options.port}/api/auth/pairing`) {
        return init?.method === "POST" ? Response.json({ code, expiresAt: Date.now() + 300_000, credential, serverName, ...fields }) : Response.json({ pairings: [], publicUrl: null });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    });
  };

  it("builds the invite for --public-url from the server's credential and name, and never prints it as text", async () => {
    pairingResponse({ url: null, inviteUrl: null });
    expect(await runPair({ ...options, phone: "android", publicUrl: explicitOrigin })).toBe(0);
    expect(printed()).not.toContain("openmausbot://");
    expect(printed()).not.toContain(credential);
    expect(printed()).toContain("scan this with the MausBot app");
  });

  it("keeps a proxy path in the web link", async () => {
    pairingResponse({ url: `https://proxy.example.test/omb/pair#code=${code}`, inviteUrl: null });
    expect(await runPair({ ...options, label: "Pixel" })).toBe(0);
    expect(printed()).toContain(`https://proxy.example.test/omb/pair#code=${code}`);
  });
});

describe("pair --ttl", () => {
  it("asks the server to keep the code open that long and says until when", async () => {
    const day = Date.now() + 86_400_000;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ app: "openmausbot", pid: 12345 });
      if (url.endsWith("/api/auth/pairing")) return init?.method === "POST" ? Response.json({ code, expiresAt: day, url: null }) : Response.json({ pairings: [], publicUrl: null });
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    expect(await runPair({ ...options, pairTtlMs: 86_400_000 })).toBe(0);
    const posted = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(posted![1]!.body))).toEqual({ ttlMs: 86_400_000 });
    expect(printed()).toMatch(/until tomorrow /);
  });
});
