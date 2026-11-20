export interface DeviceLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
  address?: string;
  addressSource?: "apple" | "google";
}

export interface NetworkLocation {
  source: "ip";
  provider: "DB-IP";
  city?: string;
  region?: string;
  country?: string;
  district?: string;
  postalCode?: string;
  networkCenter?: { latitude: number; longitude: number };
}

export function parseNetworkLocation(value: unknown): NetworkLocation | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const label = (field: unknown) => cleanLocationAddress(field)?.slice(0, 100);
  const city = label(data.city), region = label(data.region), country = label(data.country);
  const district = label(data.district), postalCode = label(data.postalCode);
  const center = data.networkCenter as { latitude?: unknown; longitude?: unknown } | undefined;
  const { latitude, longitude } = center ?? {};
  const networkCenter = typeof latitude === "number" && Math.abs(latitude) <= 90 &&
    typeof longitude === "number" && Math.abs(longitude) <= 180 ? { latitude, longitude } : undefined;
  if (!city && !region && !country && !district && !postalCode && !networkCenter) return null;
  return { source: "ip", provider: "DB-IP", city, region, country, district, postalCode, networkCenter };
}

export const LOCATION_FAILURES = ["permission-denied", "position-interrupted", "position-unavailable", "position-timed-out", "page-hidden"] as const;
export type LocationFailure = typeof LOCATION_FAILURES[number];
export type LocationResult = DeviceLocation | NetworkLocation | LocationFailure | null;

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
