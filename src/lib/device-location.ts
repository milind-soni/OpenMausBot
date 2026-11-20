import { randomUuid } from "./random-uuid";
import {
  DEVICE_LOCATION_EVENT, DEVICE_LOCATION_HEADER, DEVICE_LOCATION_PATH, DEVICE_LOCATION_TIMEOUT,
  isUsableDeviceFix, LOCATION_FAILURES, parseNetworkLocation, type DeviceLocation, type LocationFailure,
} from "../../shared/device-location";

let clientId: string | undefined;

export function locationClientId(): string | undefined {
  if (typeof window === "undefined" || window.top !== window) return;
  if (!window.ogb?.currentLocation && (window.ogb || !window.isSecureContext || !navigator.geolocation)) return;
  return clientId ??= randomUuid();
}

export async function deviceLocation(): Promise<DeviceLocation> {
  if (window.ogb?.currentLocation) {
    const fix = await window.ogb.currentLocation();
    if (typeof fix === "string") throw fix;
    return fix;
  }

  const geo = navigator.geolocation;
  const readFix = ({ coords, timestamp }: GeolocationPosition): DeviceLocation | undefined => {
    const { latitude, longitude, accuracy } = coords;
    const fix = { latitude, longitude, accuracy, timestamp };
    if (isUsableDeviceFix(fix)) return fix;
  };
  const locateOnce = (enableHighAccuracy: boolean, timeout: number) => new Promise<DeviceLocation>((resolve, reject) => {
    geo.getCurrentPosition(position => {
      const fix = readFix(position);
      if (fix) resolve(fix);
      else reject({ code: 2 });
    }, reject, { enableHighAccuracy, maximumAge: 0, timeout });
  });
  const locate = (enableHighAccuracy: boolean, timeout: number) => {
    if (typeof geo.watchPosition !== "function") return locateOnce(enableHighAccuracy, timeout);
    return new Promise<DeviceLocation>((resolve, reject) => {
      let watch: number | undefined;
      let settled = false;
      let lastError: GeolocationPositionError | { code: number } = { code: 3 };
      const cleanup = () => {
        clearTimeout(deadline);
        if (watch !== undefined) geo.clearWatch(watch);
      };
      const finish = (fix?: DeviceLocation) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (fix) resolve(fix);
        else reject(lastError);
      };
      const deadline = setTimeout(finish, timeout);
      try {
        watch = geo.watchPosition(position => {
          const fix = readFix(position);
          if (fix) finish(fix);
        }, error => {
          lastError = error;
          if (error.code === 1) finish();
        }, { enableHighAccuracy, maximumAge: 0, timeout });
        if (settled) cleanup();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  };

  try {
    return await locate(true, 15_000);
  } catch (error) {
    const code = (error as GeolocationPositionError | undefined)?.code;
    if (code !== 2 && code !== 3) throw error;
    return locate(false, 8_000);
  }
}

async function ipLocation(timeout: number) {
  const key = import.meta.env?.VITE_OMB_DBIP_PUBLIC_KEY?.trim() || "free";
  try {
    const response = await fetch(`https://api.db-ip.com/v2/${encodeURIComponent(key)}/self`, {
      signal: AbortSignal.timeout(timeout),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || body.errorCode || body.countryCode === "ZZ") return null;
    return parseNetworkLocation({
      city: body.city, region: body.stateProv, country: body.countryName,
      district: body.district, postalCode: body.zipCode,
      networkCenter: { latitude: body.latitude, longitude: body.longitude },
    });
  } catch {
    return null;
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
        failure = LOCATION_FAILURES.find(reason => reason === error) ??
          (code === 1 ? "permission-denied" : code === 3 ? "position-timed-out" : "position-unavailable");
      }
    }
    const active = () => document.visibilityState === "visible" && document.hasFocus();
    const remaining = DEVICE_LOCATION_TIMEOUT - (Date.now() - started) - 1_000;
    let networkLocation = null;
    if (!position && (failure === "position-unavailable" || failure === "position-timed-out") && active() && remaining > 0) {
      networkLocation = await ipLocation(Math.min(remaining, 4_000));
    }
    if (Date.now() - started >= DEVICE_LOCATION_TIMEOUT) return;
    if (!active()) {
      position = null;
      networkLocation = null;
      failure = "page-hidden";
    }
    void fetch(DEVICE_LOCATION_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", [DEVICE_LOCATION_HEADER]: id },
      body: JSON.stringify({ request, position, failure, ...(networkLocation ? { networkLocation } : {}) }),
    }).catch(() => {});
  });
}
