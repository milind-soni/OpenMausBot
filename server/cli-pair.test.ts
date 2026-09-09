import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPair, type CliOptions } from "./cli.ts";
import { SetupCancelled } from "./cli-prompts.ts";
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
  tailscaleServe: vi.fn(), tailscaleServeOff: vi.fn(), explainTailscaleFailure: vi.fn(),
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

function expectPhonePairing(origin: string): void {
  const probes = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://"));
  expect(probes).toHaveLength(1);
  expect(String(probes[0]![0])).toBe(`${origin}/.well-known/openmausbot/environment`);
  expect(probes[0]![1]).not.toHaveProperty("body");
  expect(probes[0]![1]).not.toHaveProperty("headers");
  const invitations = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(invitations).toHaveLength(1);
  expect(String(invitations[0]![0])).toBe(`http://127.0.0.1:${options.port}/api/auth/pairing`);
  expect(JSON.parse(String(invitations[0]![1]?.body))).toMatchObject({ scopes: ["client"] });
  const transcript = mocks.ui.log.mock.calls.map(([line]) => line).join("\n");
  expect(transcript).toContain(`pairing code:  ${code}`);
  expect(transcript).toContain(`${origin}/pair#code=${code}`);
  expect(transcript).toMatch(/[▀▄█]/);
  expect(mocks.createTunnelAccount).not.toHaveBeenCalled();
  expect(mocks.tailscaleStatus).not.toHaveBeenCalled();
}

describe("guided phone pairing address discovery", () => {
  it.each([
    { access: "tunnel", phone: "ios" },
    { access: "tailscale", phone: "android" },
    { access: "public-url", publicUrl: "https://old-proxy.example.test", phone: "ios" },
  ])("uses the running server's advertised origin instead of saved $access access", async (saved) => {
    mocks.readCliStartup.mockReturnValue(saved);
    expect(await runPair(options)).toBe(0);
    expectPhonePairing(advertisedOrigin);
  });

  it("allows an explicit --public-url to override the advertised and saved addresses", async () => {
    mocks.readCliStartup.mockReturnValue({ access: "tunnel", phone: "ios" });
    expect(await runPair({ ...options, publicUrl: explicitOrigin })).toBe(0);
    expectPhonePairing(explicitOrigin);
  });

  it.each([
    "https://localhost",
    "https://user:stale-secret@example.test",
    "https://old.example.test/pair#code=stale-code",
    undefined,
  ])("ignores an invalid saved public URL (%s) when the server advertises a valid origin", async (savedUrl) => {
    mocks.readCliStartup.mockReturnValue({ access: "public-url", publicUrl: savedUrl, phone: "ios" });
    expect(await runPair(options)).toBe(0);
    expectPhonePairing(advertisedOrigin);
  });

  it("does not read stale or unreadable setup settings before using the running origin", async () => {
    mocks.readCliStartup.mockImplementation(() => { throw new Error("Fixture config is stale or unreadable"); });
    expect(await runPair(options)).toBe(0);
    expect(mocks.readCliStartup).not.toHaveBeenCalled();
    expectPhonePairing(advertisedOrigin);
  });

  it("does not probe a fabricated origin when Tailscale has no MagicDNS name", async () => {
    publicUrl = null;
    mocks.readCliStartup.mockReturnValue({ access: "tailscale", phone: "ios" });
    mocks.tailscaleStatus.mockResolvedValue({ status: { dnsName: null } });
    expect(await runPair(options)).toBe(1);
    expect(mocks.ui.choose).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://"))).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("running only on this computer"));
  });

  it("does not mint a code when the advertised endpoint identifies another workspace", async () => {
    remoteWorkspaceId = "another-workspace";
    expect(await runPair(options)).toBe(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(mocks.ui.log).toHaveBeenCalledWith(expect.stringContaining("no phone pairing code was created"));
  });

  it.each([2, new SetupCancelled()])("does not mint a code when phone selection is cancelled (%s)", async (cancel) => {
    if (cancel instanceof Error) mocks.ui.choose.mockRejectedValue(cancel);
    else mocks.ui.choose.mockResolvedValue(cancel);
    expect(await runPair(options)).toBe(cancel instanceof Error ? 130 : 0);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://"))).toHaveLength(0);
  });
});
