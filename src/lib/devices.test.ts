import { describe, expect, it } from "vitest";
import type { ServerStatus } from "../../electron/server-status.mjs";
import type { CompanionState, PhoneDevice } from "./companion-types";
import { vpsServerId, type BotComputerRow } from "../../shared/bot-computers";
import { withBots } from "./device-bots";
import { buildDevices, groupByKind, kindFromLabel, nameKey, privateNetwork, type DeviceSources } from "./devices";
import { setLocale } from "./i18n";
import { networkLine, networkShort } from "../components/devices/device-words";
import type { PublicPhone } from "./phones";

const NOW = 1_800_000_000_000;
const here = { name: "This computer", kind: "computer" as const, version: "0.1.180", desktop: true };
const status = (id: string, over: Partial<ServerStatus> = {}): ServerStatus => ({ id, state: "connected", since: NOW, version: "0.1.180", behind: false, install: "npx", ...over });
const phone = (id: string, name: string, over: Partial<PhoneDevice> = {}): PhoneDevice => ({ id, name, createdAt: NOW - 1e9, lastSeenAt: NOW - 3_600_000, cloudDesktopAccess: false, ...over });
const app = (key: string, name: string, online = true): PublicPhone => ({
  key, registration: { installId: key, name, platform: "ios", appVersion: "2.4.0", timeZone: "UTC", capabilities: {} }, registeredAt: NOW - 1e9, seen: NOW - 60_000, lastUsedAt: null, online, busy: false,
});
const places = (environments: NonNullable<DeviceSources["places"]>["environments"]): NonNullable<DeviceSources["places"]> =>
  ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments });
const build = (over: Partial<DeviceSources>) => buildDevices({ here, now: NOW, ...over });

describe("the device list", () => {
  it("is this place alone when nothing else is connected", () => {
    const [self, ...rest] = build({});
    expect(rest).toEqual([]);
    expect(self).toMatchObject({ id: "here", kind: "laptop", status: "online", route: "here", here: true, canRunBots: true, canHostComputer: true, version: "0.1.180" });
    expect(buildDevices({ here: { name: "My Cloud", kind: "cloud", desktop: false } })[0]).toMatchObject({ kind: "cloud", canHostComputer: false });
  });

  it("reads each saved place as a Cloud or a server, with how it is reached and the one thing to do", () => {
    const devices = build({
      places: places([
        { id: "local", kind: "local", name: "This computer" },
        { id: "home", kind: "remote", name: "My Cloud", origin: "https://ada.mausbot.cloud", home: true },
        { id: "mini", kind: "remote", name: "Studio", origin: "http://studio-mini.tail1234.ts.net:8799" },
        { id: "vps", kind: "remote", name: "Hetzner box", origin: "https://maus.example.com" },
        { id: "lan", kind: "remote", name: "Old PC", origin: "http://192.168.1.40:8799" },
      ]),
      statuses: [status("mini", { behind: true, version: "0.1.170", install: "global" }), status("vps", { state: "cantReach" }), status("lan", { state: "signedOut" })],
      lending: [{ id: "mini", enabled: true }, { id: "lan", enabled: false }],
    });
    expect(devices.map((device) => device.id)).toEqual(["here", "place:home", "place:mini", "place:vps", "place:lan"]);
    const [, home, mini, vps, lan] = devices;
    expect(home).toMatchObject({ kind: "cloud", route: "cloud", status: "unknown", canRunBots: true, home: true });
    expect(devices.filter((device) => device.usesThisComputer).map((device) => device.id)).toEqual(["place:mini"]);
    expect(home!.address).toBeUndefined();
    expect(home!.actions.map((action) => action.type)).toEqual(["switch"]);
    expect(mini).toMatchObject({ kind: "server", route: "tailscale", status: "attention", note: "update", version: "0.1.170", address: "http://studio-mini.tail1234.ts.net:8799" });
    expect(mini!.actions).toContainEqual({ type: "copy-update", install: "global" });
    expect(vps).toMatchObject({ route: "internet", status: "offline", note: "unreachable" });
    expect(vps!.actions.map((action) => action.type)).toEqual(["switch", "retry", "copy-address", "remove"]);
    expect(lan).toMatchObject({ route: "local", status: "attention", note: "signed-out" });
    expect(lan!.actions.map((action) => action.type)).toEqual(["switch", "pair-again", "copy-address", "remove"]);
    expect(mini!.actions.some((action) => action.type === "pair-again" || action.type === "retry")).toBe(false);
  });

  it("leaves out the place on screen and this computer's own environments", () => {
    const devices = build({ places: { ...places([{ id: "home", kind: "remote", name: "My Cloud", origin: "https://a.mausbot.cloud", home: true }, { id: "env2", kind: "local", name: "Work", dataDir: "/x" }]), activeId: "home" } });
    expect(devices.map((device) => device.id)).toEqual(["here"]);
  });

  it("reads paired phones with their live route, offline ones by the way they may use", () => {
    const companion: Pick<CompanionState, "devices" | "connectedDeviceIds" | "routes"> = {
      devices: [phone("a", "Ada's iPhone", { route: "wifi" }), phone("b", "Pixel 9", { route: "tailscale" }), phone("c", "iPad", { route: null })],
      connectedDeviceIds: ["a", "b"],
      routes: { wifi: { on: true, since: 1 }, relay: { on: true, since: 1 }, tailscale: { on: true, since: 1, name: "ada.ts.net" }, https: { on: false, since: null } },
    };
    const [, a, b, c] = build({ companion });
    expect(a).toMatchObject({ id: "phone:a", kind: "phone", status: "online", route: "local" });
    expect(b).toMatchObject({ status: "online", route: "tailscale" });
    expect(c).toMatchObject({ status: "offline", route: "relay", lastSeen: NOW - 3_600_000 });
    expect(c!.actions[0]).toEqual({ type: "remove", source: { type: "phone", id: "c" } });
  });

  it("joins a phone paired here and the same phone's apps into one device, removable from both", () => {
    const devices = build({ companion: { devices: [phone("a", "Ada’s iPhone")], connectedDeviceIds: [] }, phoneApps: [app("k1", "ada's iphone"), app("k2", "Work Android", false)] });
    expect(devices.map((device) => device.id)).toEqual(["here", "phone:a", "phone-app:k2"]);
    const [, joined, other] = devices;
    expect(joined).toMatchObject({ status: "online", version: "2.4.0" });
    expect(joined!.sources).toEqual([{ type: "phone", id: "a" }, { type: "phone-app", id: "k1" }]);
    expect(joined!.actions.filter((action) => action.type === "remove")).toHaveLength(2);
    expect(other).toMatchObject({ status: "offline", route: "paired" });
  });

  it("joins a server reached over Tailscale and the same machine paired here under its host name", () => {
    const devices = build({
      companion: { devices: [], connectedDeviceIds: [], routes: { wifi: { on: false, since: null }, relay: { on: false, since: null }, tailscale: { on: true, since: 1, name: "me.ts.net", computers: true }, https: { on: false, since: null } } },
      places: places([{ id: "mini", kind: "remote", name: "Studio", origin: "http://studio-mini.tail1234.ts.net:8799" }]),
      statuses: [status("mini", { state: "cantReach" })],
      sessions: { current: null, sessions: [{ id: "s1", label: "Studio Mini", scopes: ["admin", "client"], lastSeenAt: NOW - 30_000 }] },
    });
    expect(devices.map((device) => device.id)).toEqual(["here", "place:mini"]);
    expect(devices[1]).toMatchObject({ status: "online", routes: ["tailscale"], sources: [{ type: "place", id: "mini" }, { type: "session", id: "s1" }] });
    expect(devices[1]!.note).toBeUndefined();
    const behind = build({
      places: places([{ id: "mini", kind: "remote", name: "Studio Mac mini", origin: "http://studio-mini.tail1234.ts.net:8799" }]),
      statuses: [status("mini", { behind: true })],
      sessions: { current: null, sessions: [{ id: "s1", label: "Studio Mac mini", scopes: ["admin"], lastSeenAt: NOW }] },
    });
    expect(behind[1]).toMatchObject({ kind: "desktop", status: "attention", note: "update" });
  });

  it("keeps two sessions with one label apart, and never joins a phone to a computer", () => {
    const sessions = [
      { id: "s1", label: "Chrome on Mac", scopes: ["admin"], lastSeenAt: NOW - 1_000 },
      { id: "s2", label: "Chrome on Mac", scopes: ["admin"], lastSeenAt: NOW - 86_400_000 },
      { id: "s3", label: "Pixel 9", scopes: ["admin"], lastSeenAt: NOW },
    ];
    const devices = build({ sessions: { current: null, sessions }, places: places([{ id: "p", kind: "remote", name: "Pixel 9", origin: "https://pixel.example.com" }]) });
    expect(devices.map((device) => device.id)).toEqual(["here", "place:p", "session:s1", "session:s2", "session:s3"]);
    expect(devices[2]).toMatchObject({ status: "online", kind: "laptop" });
    expect(devices[3]).toMatchObject({ status: "offline" });
    expect(devices[4]).toMatchObject({ kind: "phone" });
  });

  it("leaves out this browser, script tokens and, on a Cloud, chat-only sessions", () => {
    const sessions = [
      { id: "me", label: "Chrome on Mac", scopes: ["admin"], lastSeenAt: NOW },
      { id: "cli", label: "Script", scopes: ["admin"], lastSeenAt: NOW, token: true as const },
      { id: "mate", label: "Safari on iPhone", scopes: ["client"], lastSeenAt: NOW },
      { id: "mine", label: "Safari on iPad", scopes: ["admin", "client"], lastSeenAt: NOW - 600_000 },
    ];
    const cloud = buildDevices({ here: { name: "My Cloud", kind: "cloud", desktop: false }, now: NOW, sessions: { current: "me", sessions } });
    expect(cloud.map((device) => device.id)).toEqual(["here", "session:mine"]);
    expect(cloud[1]).toMatchObject({ route: "cloud", kind: "phone", status: "offline" });
    const server = buildDevices({ here: { name: "box", kind: "server", desktop: false }, now: NOW, sessions: { current: "me", sessions } });
    expect(server.map((device) => device.id)).toEqual(["here", "session:mate", "session:mine"]);
    expect(server[1]!.route).toBe("internet");
  });

  it("reads lent computers that still lend, and servers bots reach over SSH, as computers bots can use", () => {
    const devices = buildDevices({
      here: { name: "My Cloud", kind: "cloud", desktop: true }, now: NOW,
      lent: [{ id: "l1", name: "Ada's MacBook", platform: "darwin", online: true, lent: true, lastSeenAt: NOW }, { id: "l2", name: "Old", platform: "linux", online: false, lent: false, lastSeenAt: 0 }],
      vps: [{ alias: "my-vps" }, { alias: "my-vps", name: "Again" }, { alias: "gpu", name: "GPU box" }],
    });
    expect(devices.map((device) => device.id)).toEqual(["here", "lent:l1", vpsServerId("my-vps"), vpsServerId("gpu")]);
    expect(devices[3]!.name).toBe("GPU box");
    expect(devices[1]).toMatchObject({ route: "cloud", canHostComputer: true, canRunBots: false, status: "online" });
    expect(devices[2]).toMatchObject({ kind: "server", route: "ssh", status: "unknown", canHostComputer: true, actions: [] });
    expect(devices[1]!.live).toBe(true);
  });

  it("marks live only what is connected at this moment: a phone on its link, a place this app is connected to", () => {
    const devices = build({
      places: places([{ id: "a", kind: "remote", name: "A", origin: "https://a.example.com" }, { id: "b", kind: "remote", name: "B", origin: "https://b.example.com" }]),
      statuses: [status("a"), status("b", { behind: true })],
      companion: { devices: [phone("on", "On"), phone("off", "Off")], connectedDeviceIds: ["on"] },
      sessions: { current: null, sessions: [{ id: "s", label: "Chrome on Windows", scopes: ["admin"], lastSeenAt: NOW - 60_000 }] },
    });
    const live = Object.fromEntries(devices.map((device) => [device.id, Boolean(device.live)]));
    expect(live).toMatchObject({ "place:a": true, "place:b": false, "phone:on": true, "phone:off": false, "session:s": false });
  });

  it("groups the map by what each device is, in one fixed order, this place apart", () => {
    const devices = build({
      places: places([{ id: "home", kind: "remote", name: "My Cloud", origin: "https://a.mausbot.cloud", home: true }, { id: "mini", kind: "remote", name: "Mac mini", origin: "http://mini.tail1.ts.net:8799" }]),
      companion: { devices: [phone("a", "Phone", { route: "wifi" })], connectedDeviceIds: ["a"] },
      vps: [{ alias: "gpu" }],
    });
    expect(groupByKind(devices).map((group) => [group.group, group.devices.map((device) => device.id)])).toEqual([
      ["phones", ["phone:a"]], ["computers", ["place:mini"]], ["servers", ["place:home", "vps:gpu"]],
    ]);
    expect(groupByKind(build({}))).toEqual([]);
  });
});

describe("the bots on each device", () => {
  const row = (botId: string, kind: BotComputerRow["kind"], computerId: string | null, state: BotComputerRow["state"], over: Partial<BotComputerRow> = {}): BotComputerRow =>
    ({ botId, kind, computerId, name: null, state, stateAt: state === "unknown" ? null : NOW, ...over });
  const names: Record<string, string> = { b1: "Scout", b2: "Writer", b3: "Builder" };
  const named = (id: string) => names[id] ?? null;
  const devices = () => build({ vps: [{ alias: "gpu", name: "GPU box" }] });
  setLocale("en");

  it("puts each bot on the device it works on, once, and makes a device of each cloud desktop", () => {
    const out = withBots(devices(), [
      row("b1", "local", "local", "ready"), row("b1", "local", "local", "ready", { threadId: "t1" }), row("b2", "vm", "vm:b2", "asleep"),
      row("b3", "vps", "vps:gpu/omb-b3", "ready", { vps: { serverId: vpsServerId("gpu"), alias: "gpu", container: "omb-b3" } }),
      row("b2", "cloud", "cloud:b2", "asleep"), row("b3", "browser", null, "unknown"), row("b1", "auto", null, "unknown"),
    ], "computer", named);
    expect(Object.fromEntries(out.map((device) => [device.id, device.bots ?? []]))).toEqual({ here: ["b1", "b2"], "vps:gpu": ["b3"], "cloud:b2": ["b2"] });
    expect(out.at(-1)).toMatchObject({ kind: "vm", name: "Writer’s cloud desktop", status: "offline", desktop: "asleep", route: "cloud" });
  });

  it("shows no state for a cloud desktop nothing knows about, and no device for a computer the server cannot name", () => {
    const out = withBots(devices(), [row("b1", "cloud", "cloud:team-1", "unknown", { name: "Team desktop" }), row("b2", "cloud", "cloud:b2", "none"), row("b3", "auto", null, "unknown")], "computer", () => null);
    expect(out.slice(-2).map((device) => [device.name, device.status, device.desktop])).toEqual([["Team desktop", "unknown", undefined], ["Cloud desktop", "unknown", undefined]]);
  });

  it("follows Auto to the place it settled on, and leaves a bot on this computer out on a Cloud's page", () => {
    const out = withBots(devices(), [row("b1", "auto", "local", "ready", { autoKind: "local" }), row("b2", "local", "local", "ready")], "cloud", named);
    expect(out.find((device) => device.here)?.bots).toBeUndefined();
    expect(withBots(devices(), [row("b1", "auto", "local", "ready", { autoKind: "local" })], "computer", named)[0]!.bots).toEqual(["b1"]);
  });

  it("draws nothing extra when the list is empty, refused or missing", () => {
    expect(withBots(devices(), [], "computer", named)).toEqual(devices());
    expect(withBots(devices(), null, "computer", named)).toEqual(devices());
  });
});

describe("names", () => {
  it("compare without case, punctuation or a .local suffix", () => {
    expect(nameKey("Ada’s MacBook-Pro.local")).toBe(nameKey("ads macbook pro".replace("ads", "adas")));
    expect(kindFromLabel("Safari on iPhone")).toBe("phone");
    expect(kindFromLabel("Studio Mac mini")).toBe("desktop");
    expect(kindFromLabel("Chrome on Windows")).toBe("laptop");
  });
});

describe("the private network", () => {
  const routes = (tailscale: Partial<NonNullable<CompanionState["routes"]>["tailscale"]>) => ({
    wifi: { on: false, since: null }, relay: { on: false, since: null }, https: { on: false, since: null }, tailscale: { on: false, since: null, ...tailscale },
  });
  it("is not shown without the desktop's phone link, and unknown until the person asks", () => {
    expect(privateNetwork(null, null)).toBeNull();
    expect(privateNetwork({ routes: routes({}) }, null)).toEqual({ state: "unknown", name: null, shared: false });
  });
  it("takes the last check's reason, then MagicDNS, then ready with this computer's name", () => {
    expect(privateNetwork({ routes: routes({}) }, "not-installed")?.state).toBe("not-installed");
    expect(privateNetwork({ routes: routes({ on: true, computers: true }) }, null)).toEqual({ state: "magicdns", name: null, shared: true });
    expect(privateNetwork({ routes: routes({ on: true, name: "ada.tail1.ts.net", computers: true }) }, null)).toEqual({ state: "ready", name: "ada.tail1.ts.net", shared: true });
  });
  it("says a tailnet with its own names (Headscale) needs a .ts.net name, and to pair over Same Wi-Fi", () => {
    setLocale("en");
    const network = privateNetwork({ routes: routes({}) }, "custom-name")!;
    expect(network.state).toBe("custom-name");
    expect(networkShort(network)).toBe("Needs a .ts.net name");
    expect(networkLine(network)).toContain("Pair the device over Same Wi-Fi instead.");
  });
});
