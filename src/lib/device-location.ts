import { randomUuid } from "./random-uuid";
import {
  DEVICE_LOCATION_EVENT, DEVICE_LOCATION_HEADER, DEVICE_LOCATION_PATH, DEVICE_LOCATION_TIMEOUT,
  type DeviceLocation, type LocationFailure,
} from "../../shared/device-location";

let clientId: string | undefined;

export function locationClientId(): string | undefined {
  if (typeof window === "undefined" || window.top !== window) return;
  if (!window.ogb?.currentLocation && (window.ogb || !window.isSecureContext || !navigator.geolocation)) return;
  return clientId ??= randomUuid();
}

export async function deviceLocation(): Promise<DeviceLocation> {
  if (window.ogb?.currentLocation) return window.ogb.currentLocation();

  const locate = (enableHighAccuracy: boolean, timeout: number) => new Promise<DeviceLocation>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(({ coords, timestamp }) => {
      const { latitude, longitude, accuracy } = coords;
      resolve({ latitude, longitude, accuracy, timestamp });
    }, reject, { enableHighAccuracy, maximumAge: 0, timeout });
  });
  try {
    return await locate(true, 15_000);
  } catch (error) {
    const code = (error as GeolocationPositionError | undefined)?.code;
    if (code !== 2 && code !== 3) throw error;
    return locate(false, 8_000);
  }
}

export function listenForDeviceLocation(source: EventSource, id: string): void {
  source.addEventListener(DEVICE_LOCATION_EVENT, async (event: MessageEvent<string>) => {
    const request = event.data;
    if (!/^[0-9a-f-]{36}$/.test(request)) return;
    const started = Date.now();
    let position: DeviceLocation | null = null;
    let failure: LocationFailure | undefined;
    if (document.visibilityState === "visible" && document.hasFocus()) {
      try {
        position = await deviceLocation();
      } catch (error) {
        const code = (error as GeolocationPositionError | undefined)?.code;
        failure = code === 1 ? "permission-denied" : code === 3 ? "position-timed-out" : "position-unavailable";
      }
    }
    if (Date.now() - started >= DEVICE_LOCATION_TIMEOUT) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) {
      position = null;
      failure = "page-hidden";
    }
    void fetch(DEVICE_LOCATION_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", [DEVICE_LOCATION_HEADER]: id },
      body: JSON.stringify({ request, position, failure }),
    }).catch(() => {});
  });
}
