import { Box, Cloud, Laptop, Monitor, Server, Smartphone, type LucideIcon } from "lucide-react";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { lastSeen } from "@/lib/pairing-time";
import type { Device, DeviceGroup, DeviceKind, DeviceRoute, PrivateNetwork, PrivateNetworkState } from "@/lib/devices";
import { productName } from "@/lib/brand";

export const KIND_ICON: Record<DeviceKind, LucideIcon> = { laptop: Laptop, desktop: Monitor, server: Server, cloud: Cloud, phone: Smartphone, vm: Box };

const KIND: Record<DeviceKind, LocaleKey> = {
  laptop: "devicesPage.kind.laptop", desktop: "devicesPage.kind.desktop", server: "devicesPage.kind.server", cloud: "devicesPage.kind.cloud",
  phone: "devicesPage.kind.phone", vm: "devicesPage.kind.cloudDesktop",
};
export const kindLabel = (kind: DeviceKind): string => t(KIND[kind]);

const ROUTE: Record<DeviceRoute, LocaleKey> = {
  here: "devicesPage.route.here", local: "devicesPage.route.local", tailscale: "devicesPage.route.tailscale", relay: "devicesPage.route.relay",
  cloud: "devicesPage.route.cloud", internet: "devicesPage.route.internet", paired: "devicesPage.route.paired", ssh: "devicesPage.route.ssh",
};
export const routeLabel = (route: DeviceRoute): string => t(ROUTE[route], { app: productName() });

const GROUP: Record<DeviceGroup, LocaleKey> = { computers: "devicesPage.group.computers", servers: "devicesPage.group.servers", phones: "devicesPage.group.phones" };
export const groupLabel = (group: DeviceGroup): string => t(GROUP[group]);

/** One short line: how it is, or the one thing it needs. */
export function statusText(device: Device, now = Date.now()): string {
  if (device.here) return t("devicesPage.status.here");
  if (device.note === "update") return t("devicesPage.note.update");
  if (device.note === "signed-out") return t("devicesPage.note.signedOut");
  if (device.note === "insecure") return t("devicesPage.note.insecure");
  if (device.note === "unreachable") return t("devicesPage.note.unreachable");
  if (device.note === "reconnecting") return t("devicesPage.note.reconnecting");
  if (device.kind === "vm") return device.desktop ? t(DESKTOP[device.desktop]) : "";
  if (device.status === "online") return t("devicesPage.status.online");
  if (device.status === "offline") return device.lastSeen ? t("devicesPage.status.seen", { when: lastSeen(device.lastSeen, now) }) : t("devicesPage.status.offline");
  if (device.route === "ssh") return t("devicesPage.status.ssh");
  if (device.kind === "cloud") return device.home ? `${t("servers.homeTag")} · ${t("servers.managed")}` : t("servers.managed");
  return device.home ? t("servers.homeTag") : t("devicesPage.status.unknown");
}

const DESKTOP: Record<NonNullable<Device["desktop"]>, LocaleKey> = {
  ready: "devicesPage.desktop.ready", asleep: "devicesPage.desktop.asleep", starting: "devicesPage.desktop.starting", unreachable: "devicesPage.note.unreachable",
};

const NETWORK_SHORT: Record<PrivateNetworkState, LocaleKey> = {
  unknown: "devicesPage.network.short.unknown", "not-installed": "devicesPage.network.short.notInstalled", "no-cli": "devicesPage.network.short.noCli",
  "signed-out": "devicesPage.network.short.signedOut", "not-running": "devicesPage.network.short.notRunning", "needs-approval": "devicesPage.network.short.needsApproval",
  "needs-permission": "devicesPage.network.short.needsPermission", magicdns: "devicesPage.network.short.magicdns", ready: "devicesPage.network.short.ready",
};
/** Two or three words for the map. */
export const networkShort = (network: PrivateNetwork): string => t(NETWORK_SHORT[network.state]);

/** The whole next step, in the Tailscale check's own words where it has them. */
export function networkLine(network: PrivateNetwork): string {
  switch (network.state) {
    case "unknown": return t("devicesPage.network.line.unknown");
    case "not-installed": return t("devicesPage.network.line.notInstalled");
    case "no-cli": return t("remote.tailscale.noCli");
    case "signed-out": return t("remote.tailscale.signIn");
    case "not-running": return t("remote.tailscale.notRunning");
    case "needs-approval": return t("remote.tailscale.needsApproval");
    case "needs-permission": return t("remote.tailscale.needsPermission", { app: productName() });
    case "magicdns": return `${t("remote.tailscale.magicDns")}. ${t("remote.tailscale.magicDnsDetail")}`;
    case "ready": return network.shared ? t("devicesPage.network.line.ready", { name: network.name ?? "" }) : t("devicesPage.network.line.notShared", { name: network.name ?? "" });
  }
}
