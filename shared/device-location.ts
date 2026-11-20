export interface DeviceLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
  address?: string;
  addressSource?: "apple" | "google";
}

export const LOCATION_FAILURES = ["permission-denied", "position-unavailable", "position-timed-out", "page-hidden"] as const;
export type LocationFailure = typeof LOCATION_FAILURES[number];
export type LocationResult = DeviceLocation | LocationFailure | null;

export const DEVICE_LOCATION_EVENT = "device-location";
export const DEVICE_LOCATION_PATH = "/api/device-location";
export const DEVICE_LOCATION_HEADER = "x-openmausbot-location-client";
export const DEVICE_LOCATION_TIMEOUT = 37_000;

export function isUsableDeviceFix(value: unknown, now = Date.now()): value is DeviceLocation {
  if (!value || typeof value !== "object") return false;
  const { latitude, longitude, accuracy, timestamp } = value as DeviceLocation;
  return Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) && Math.abs(longitude) <= 180 &&
    Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100_000 &&
    Number.isFinite(timestamp) && timestamp >= now - 60_000 && timestamp <= now + 5_000;
}

export function parseDeviceLocation(value: unknown, now = Date.now()): DeviceLocation | null {
  if (!isUsableDeviceFix(value, now)) return null;
  const { latitude, longitude, accuracy, timestamp } = value;
  const address = cleanLocationAddress(value.address);
  return {
    latitude: Number(latitude.toFixed(5)),
    longitude: Number(longitude.toFixed(5)),
    accuracy: Math.ceil(accuracy + 1),
    timestamp,
    ...(address ? { address, addressSource: "apple" } : {}),
  };
}


export function cleanLocationAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  return value.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 300) || undefined;
}
