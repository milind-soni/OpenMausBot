import type { HostedComputersConfig, AddedProvider } from "../../shared/hosted-computers.ts";

export type Machine = { id: string; name: string; state: string };
export type Screen = { png: string; format: "png" | "jpeg" };
export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export interface ComputerProvider {
  check(): Promise<void>;
  find(name: string): Promise<Machine | null>;
  get(id: string, name: string): Promise<Machine>;
  create(name: string): Promise<Machine>;
  start(machine: Machine): Promise<Machine>;
  stop(machine: Machine): Promise<void>;
  screenshot(machine: Machine): Promise<Screen>;
  execute(machine: Machine, command: string): Promise<CommandResult>;
  /** Bounded coding job, inside the same authenticated sandbox. */
  code?(machine: Machine, command: string): Promise<CommandResult>;
}

export class ComputerProviderError extends Error {
  status: number;
  constructor(status = 502) { super("The cloud computer is unavailable. Check its setup in Admin and retry."); this.status = status; }
}
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function screen(image: unknown, format: "png" | "jpeg"): Screen {
  if (typeof image !== "string" || image.length > 12_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new ComputerProviderError();
  const bytes = Buffer.from(image, "base64");
  if (format === "png" ? !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] !== 255 || bytes[1] !== 216) throw new ComputerProviderError();
  return { png: image, format };
}

/** API URLs are fixed in production. Only an explicit loopback fixture override is accepted. */
function fixtureUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) throw new ComputerProviderError(400);
  return value.replace(/\/$/, "");
}

export function orgoProvider(config: NonNullable<HostedComputersConfig["orgo"]>, fetcher: typeof fetch = fetch): ComputerProvider {
  const base = fixtureUrl(process.env.NATION_TEST_ORGO_API, "https://www.orgo.ai/api");
  if (!config.apiKey || !safeId(config.workspaceId)) throw new ComputerProviderError(409);
  const workspace = config.workspaceId;
  async function request(path: string, body?: unknown, timeout = 30_000): Promise<Record<string, unknown>> {
    const response = await fetcher(`${base}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new ComputerProviderError(response.status === 404 ? 404 : response.status === 409 ? 409 : 502);
    if (Number(response.headers.get("content-length")) > 13_000_000) throw new ComputerProviderError();
    const text = await response.text();
    if (text.length > 13_000_000) throw new ComputerProviderError();
    const data = JSON.parse(text) as Record<string, unknown>;
    if (!data || typeof data !== "object" || data.success === false) throw new ComputerProviderError();
    return data;
  }
  function machine(raw: unknown, name: string): Machine {
    const data = raw as Record<string, unknown>;
    if (!data || !safeId(data.id) || data.name !== name || data.workspace_id !== workspace || typeof data.status !== "string") throw new ComputerProviderError(409);
    const state = data.status === "running" || data.status === "suspended" ? "running"
      : data.status === "frozen" || data.status === "stopped" ? "stopped" : data.status;
    return { id: data.id, name, state };
  }
  const get = async (id: string, name: string) => {
    if (!safeId(id)) throw new ComputerProviderError(400);
    return machine(await request(`/computers/${id}`), name);
  };
  return {
    async check() {
      const data = await request(`/workspaces/${workspace}`);
      if (data.id !== workspace || !Array.isArray(data.desktops)) throw new ComputerProviderError();
    },
    async find(name) {
      const data = await request(`/workspaces/${workspace}`);
      if (data.id !== workspace || !Array.isArray(data.desktops)) throw new ComputerProviderError();
      const matches = data.desktops.filter(d => d && typeof d === "object" && (d as Record<string, unknown>).name === name);
      if (matches.length > 1) throw new ComputerProviderError(409);
      return matches.length ? get((matches[0] as Record<string, string>).id, name) : null;
    },
    get,
    async create(name) {
      return machine(await request("/computers", { workspace_id: workspace, name, os: "linux", ram: 4, cpu: 1 }, 90_000), name);
    },
    async start(m) {
      if (m.state !== "running") {
        if (m.state !== "stopped") throw new ComputerProviderError(409);
        await request(`/computers/${m.id}/start`, {}, 90_000);
      }
      return get(m.id, m.name);
    },
    async stop(m) { if (m.state === "running") await request(`/computers/${m.id}/stop`, {}, 90_000); },
    async screenshot(m) {
      const data = await request(`/computers/${m.id}/screenshot?response_format=base64&format=png`);
      return screen(data.image, "png");
    },
    async execute(m, command) {
      const data = await request(`/computers/${m.id}/bash`, { command, timeout: 60 }, 95_000);
      if (!Number.isInteger(data.exit_code) || typeof data.output !== "string") throw new ComputerProviderError();
      return { exitCode: Number(data.exit_code), stdout: data.output.slice(-32_000), stderr: "" };
    },
  };
}

/** Use the official SDK for sandbox and toolbox authentication. No API key reaches the guest. */
export async function daytonaProvider(config: NonNullable<HostedComputersConfig["daytona"]>): Promise<ComputerProvider> {
  if (!config.apiKey || !config.snapshot) throw new ComputerProviderError(409);
  const { Daytona } = await import("@daytona/sdk");
  const client = new Daytona({ apiKey: config.apiKey, apiUrl: fixtureUrl(process.env.NATION_TEST_DAYTONA_API, "https://app.daytona.io/api"),
    useDeprecatedPolling: true, otelEnabled: false, requestTimeoutMs: 90_000 });
  const machine = (s: { id: string; name?: string; state?: string; labels?: Record<string, string> }, name: string): Machine => {
    if (!safeId(s.id) || s.name !== name || s.labels?.nation_owner !== name) throw new ComputerProviderError(409);
    return { id: s.id, name, state: s.state === "started" ? "running" : s.state ?? "unknown" };
  };
  const getSandbox = async (m: Machine) => {
    const s = await client.get(m.id);
    machine(s, m.name);
    return s;
  };
  return {
    async check() {
      const snapshot = await client.snapshot.get(config.snapshot!);
      if (snapshot.state !== "active") throw new ComputerProviderError(409);
    },
    async find(name) {
      try { return machine(await client.get(name), name); }
      catch (error) {
        const e = error as { statusCode?: number; response?: { status?: number } };
        if (e.statusCode === 404 || e.response?.status === 404) return null;
        throw error;
      }
    },
    async get(id, name) { return machine(await client.get(id), name); },
    async create(name) {
      const s = await client.create({ name, snapshot: config.snapshot, labels: { nation_owner: name },
        public: false, autoStopInterval: 30, autoDeleteInterval: -1, ephemeral: false }, { timeout: 90 });
      return machine(s, name);
    },
    async start(m) {
      const s = await getSandbox(m);
      if (s.state !== "started") await s.start(90);
      await s.computerUse.start();
      await s.refreshData();
      return machine(s, m.name);
    },
    async stop(m) { const s = await getSandbox(m); if (s.state === "started") await s.stop(); },
    async screenshot(m) { const s = await getSandbox(m); const result = await s.computerUse.screenshot.takeFullScreen(); return screen(result.screenshot, "png"); },
    async execute(m, command) {
      const result = await (await getSandbox(m)).process.executeCommand(command, undefined, undefined, 60);
      return { exitCode: result.exitCode, stdout: result.result.slice(-32_000), stderr: "" };
    },
    async code(m, command) {
      const result = await (await getSandbox(m)).process.executeCommand(command, undefined, undefined, 620);
      return { exitCode: result.exitCode, stdout: result.result.slice(-32_000), stderr: "" };
    },
  };
}

export async function createComputerProvider(provider: AddedProvider, config: HostedComputersConfig): Promise<ComputerProvider> {
  return provider === "orgo" ? orgoProvider(config.orgo ?? {}) : daytonaProvider(config.daytona ?? {});
}
