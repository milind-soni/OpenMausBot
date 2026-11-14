import type { InstanceInfo } from "@/state/store";
import { canWorkOnCloud, type CloudEngine } from "../../shared/cloud-computer";
import { isCloudComputerBusyMessage } from "../../shared/computer-contention";

export function isRemoteScreenshotContention(error: { status: number; message: string }): boolean {
  return error.status === 409 && [
    "this bot's cloud computer is being changed — wait for it to finish",
    "the VPS is being prepared — try again shortly",
    "VPS connection settings are being updated — wait for them to finish",
    "Boat account settings are being updated — wait for them to finish",
  ].includes(error.message);
}

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

/** The host's Local VM preview answers `{ image }` as a PNG or JPEG data URL; anything else shows no frame. */
export function localVmScreenshotSource(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const { image } = raw as { image?: unknown };
  return typeof image === "string" && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image) ? image : null;
}

export function cloudEngineOf(instance: InstanceInfo | undefined): CloudEngine {
  return { computerMcp: instance?.capabilities?.computerMcp };
}

export function boatCapableEngine(instances: readonly InstanceInfo[], selectedId?: string): InstanceInfo | undefined {
  const selected = selectedId ? instances.find(instance => instance.instanceId === selectedId) : undefined;
  return selected && canWorkOnCloud(cloudEngineOf(selected)) ? selected : undefined;
}
