import type { InstanceInfo } from "@/state/store";
import { isCloudComputerBusyMessage } from "../../shared/computer-contention";

/** Older hosts return only a message/status pair. Do not hide unrelated
 * 409s such as missing configuration or an incompatible desktop image. */
export function isRemoteScreenshotContention(error: { status: number; message: string }): boolean {
  return error.status === 409 && [
    "this bot's cloud computer is being changed — wait for it to finish",
    "the VPS is being prepared — try again shortly",
    "VPS connection settings are being updated — wait for them to finish",
    "Box account settings are being updated — wait for them to finish",
  ].includes(error.message);
}

/** The server's 409 for provision/sleep while a turn owns the bot's cloud
 * computer. A wait, not a fault: the panel keeps watching and re-resolves
 * when the turn ends. `status` is optional because the panel's `api()`
 * rejections do not always carry one. */
export function isActiveTurnRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, message } = error as { status?: unknown; message?: unknown };
  if (status !== undefined && status !== 409) return false;
  return typeof message === "string" && isCloudComputerBusyMessage(message);
}

export function remoteScreenshotSource(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as { png?: unknown; format?: unknown };
  if (typeof frame.png !== "string" || !frame.png || !/^[A-Za-z0-9+/=]+$/.test(frame.png)) return null;
  if (frame.format !== "png" && frame.format !== "jpeg") return null;
  return `data:${frame.format === "jpeg" ? "image/jpeg" : "image/png"};base64,${frame.png}`;
}

/** Match the server: selected bridge-capable engine, otherwise the Box runner. */
export function cloudRunner(instances: readonly InstanceInfo[], selectedId?: string): InstanceInfo | undefined {
  if (!selectedId) return undefined;
  const selected = instances.find(instance => instance.instanceId === selectedId);
  return selected?.capabilities?.cloudComputerMcp ? selected : instances.find(instance => instance.driverKind === "boxAgent");
}
