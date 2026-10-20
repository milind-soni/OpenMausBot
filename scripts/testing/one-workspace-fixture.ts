// This computer and My Cloud as one workspace, on the two real servers of testing/cloud-send-fixture.ts: main's own
// wiring (electron/one-workspace.mjs) with a fake ipcMain, reading My Cloud through the edge with the owner's session
// as the window's cookie would, and this computer over its private desktop-owner capability.
import { join } from "node:path";
import { installOneWorkspace } from "../../electron/one-workspace.mjs";
import type { CloudSendFixture } from "./cloud-send-fixture.ts";

export interface OneWorkspaceWiring {
  /** Main's handlers, as this computer's page ("local") or My Cloud's ("cloud") calls them. */
  call<T>(channel: string, page: "local" | "cloud" | null, ...args: unknown[]): Promise<T>;
  /** My Cloud's power gate as main holds it; set `asleepNow` for an asleep Cloud. */
  power: { asleepNow: boolean; held: number; asleep(): boolean; hold(): void };
  /** Set to make My Cloud unreachable, as a network that drops every call. */
  network: { down: boolean };
  /** Where main moved the window, in order. */
  went: Array<"cloud" | "local">;
  /** Every call main made to My Cloud: its route and headers. */
  cloudCalls: Array<{ url: string; headers: Record<string, string> }>;
  /** What main pushed to the window. */
  pushed: unknown[];
  menu: ReturnType<typeof installOneWorkspace>["menu"];
}

export function wireOneWorkspace(fx: CloudSendFixture, options: {
  cloudOrigin?: string;
  file?: string;
  shown?: () => "local" | "cloud";
  goCloud?: () => Promise<unknown>;
  goLocal?: () => Promise<unknown>;
} = {}): OneWorkspaceWiring {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const went: OneWorkspaceWiring["went"] = [];
  const cloudCalls: OneWorkspaceWiring["cloudCalls"] = [];
  const pushed: unknown[] = [];
  const origin = options.cloudOrigin ?? fx.cloudBase;
  const power = { asleepNow: false, held: 0, asleep() { return this.asleepNow; }, hold() { this.held++; } };
  const network = { down: false };
  const { menu } = installOneWorkspace({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); } },
    page: (event: unknown) => (event as { page?: "local" | "cloud" | null })?.page ?? null,
    window: () => ({ isDestroyed: () => false, webContents: {
      mainFrame: { url: options.shown?.() === "cloud" ? `${origin}/` : `${fx.desktopBase}/` },
      send: (_channel: string, value: unknown) => { pushed.push(value); },
    } }),
    localOrigin: () => fx.desktopBase,
    file: () => options.file ?? join(fx.root, "one-workspace.json"),
    cloud: () => ({ origin, name: "My Cloud" }),
    cookieFetch: (async (url: string, init: RequestInit = {}) => {
      const headers = { ...(init.headers as Record<string, string>) };
      cloudCalls.push({ url, headers });
      if (network.down) throw new TypeError("fetch failed");
      return fetch(url, { ...init, headers: { ...headers, ...fx.edge, authorization: `Bearer ${fx.owner}` } });
    }) as typeof fetch,
    reconnect: async () => false,
    power,
    local: (route: string) => fetch(`${fx.desktopBase}${route}`, { headers: { "x-openmausbot-desktop-owner": fx.ownerCapability } }),
    localDefault: () => true,
    twinHome: () => "computer",
    goCloud: async () => { went.push("cloud"); await options.goCloud?.(); },
    goLocal: async () => { went.push("local"); await options.goLocal?.(); },
  });
  return {
    call: <T>(channel: string, page: "local" | "cloud" | null, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({ page }, ...args)) as Promise<T>,
    power, network, went, cloudCalls, pushed, menu,
  };
}

const MODEL = { instanceId: "claude", model: "claude-sonnet-5" };

/** Each side's starter bot removed, then this computer: Ember (sent to My Cloud with its picture) and Juno in Research.
 * My Cloud: its Chief Miso and Atlas in Ops, Kit in Research, and the Launch room. */
export async function seedOneWorkspace(fx: CloudSendFixture, picture: Uint8Array): Promise<Record<"ember" | "juno" | "miso" | "atlas" | "kit" | "launch", string>> {
  const create = async (side: "local" | "onCloud", name: string, patch: Record<string, unknown> = {}) => {
    const bot = (await fx[side]("POST", "/api/bots", { name, modelSelection: MODEL })).body.bot as { id: string };
    if (Object.keys(patch).length) await fx[side]("PATCH", `/api/bots/${bot.id}`, patch);
    return bot.id;
  };
  for (const side of ["local", "onCloud"] as const) {
    const starters = (await fx[side]("GET", "/api/bots?messages=0")).body.bots as Array<{ id: string }>;
    for (const starter of starters) await fx[side]("DELETE", `/api/bots/${starter.id}`);
  }
  const ember = await create("local", "Ember", { soul: "You are Ember. Keep answers short.", title: "Research helper", avatarUrl: await fx.picture(picture) });
  const juno = await create("local", "Juno", { title: "Writes the weekly notes" });
  await fx.local("POST", "/api/sidebar-sections", { name: "Research", botIds: [juno] });
  const miso = await create("onCloud", "Miso", { soul: "You are Miso, the Chief of Staff.", title: "Chief of Staff" });
  const atlas = await create("onCloud", "Atlas", { soul: "You are Atlas. Watch the inbox.", title: "Watches the inbox 24/7" });
  const kit = await create("onCloud", "Kit", { title: "Nightly research digest" });
  await fx.onCloud("POST", "/api/sidebar-sections", { name: "Ops", botIds: [miso, atlas] });
  await fx.onCloud("POST", "/api/sidebar-sections", { name: "Research", botIds: [kit] });
  const launch = (await fx.onCloud("POST", "/api/groups", { memberIds: [miso, atlas], name: "Launch" })).body.group.id as string;
  await fx.onCloud("PATCH", `/api/groups/${launch}`, { section: "Ops" });
  const sent = await fx.call<{ result: { bots: string[]; failed: unknown[] } }>("cloud-send:send", "local", { keys: [`bot:${ember}`] });
  if (sent.result.failed.length || !sent.result.bots.includes("Ember")) throw new Error(`Send did not take Ember to My Cloud: ${JSON.stringify(sent.result)}`);
  return { ember, juno, miso, atlas, kit, launch };
}
