import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  DEVICE_LOCATION_HEADER, DEVICE_LOCATION_EVENT, DEVICE_LOCATION_TIMEOUT, cleanLocationAddress, parseDeviceLocation, parseNetworkLocation, LOCATION_FAILURES, type DeviceLocation, type LocationFailure, type LocationResult,
} from "../../shared/device-location.ts";
import type { RequestAuth } from "../request-auth.ts";

export function locationClientKey(auth: RequestAuth, client: unknown): string | undefined {
  if (typeof client !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(client)) return;
  if (auth.kind === "session" && auth.via === "cookie") return `${auth.session.id}:${client}`;
  if (auth.kind === "loopback" && auth.trust !== "service" && !auth.companionDevice) return `local:${client}`;
}

export class DeviceLocations {
  private readonly sends = new Map<string, string>();
  private readonly pending = new Map<string, { client: string; finish: (position: LocationResult) => void }>();

  bind(client: string, threadId: string, sendId: string) {
    const send = `${threadId}:${sendId}`;
    if (this.sends.has(send)) return;
    this.sends.set(send, client);
    if (this.sends.size > 4096) this.sends.delete(this.sends.keys().next().value!);
  }

  clientFor(threadId: string, sendId: string): string | undefined {
    return this.sends.get(`${threadId}:${sendId}`);
  }

  request(client: string, write: (frame: string) => void, signal: AbortSignal): Promise<LocationResult> {
    if (signal.aborted || [...this.pending.values()].some(request => request.client === client)) return Promise.resolve(null);
    return new Promise(resolve => {
      const request = randomUUID();
      const finish = (position: LocationResult) => {
        clearTimeout(timer);
        this.pending.delete(request);
        signal.removeEventListener("abort", abort);
        resolve(position);
      };
      const abort = () => finish(null);
      const timer = setTimeout(abort, DEVICE_LOCATION_TIMEOUT);
      this.pending.set(request, { client, finish });
      signal.addEventListener("abort", abort, { once: true });
      try { write(`event: ${DEVICE_LOCATION_EVENT}\ndata: ${request}\n\n`); } catch { abort(); }
    });
  }

  reply(auth: RequestAuth, clientHeader: unknown, body: { request?: unknown; position?: unknown; failure?: unknown; networkLocation?: unknown } | null): boolean {
    const client = locationClientKey(auth, clientHeader);
    const pending = typeof body?.request === "string" ? this.pending.get(body.request) : undefined;
    if (!pending || pending.client !== client) return false;
    const failure = LOCATION_FAILURES.find(reason => reason === body?.failure);
    const network = failure === "position-unavailable" || failure === "position-timed-out"
      ? parseNetworkLocation(body?.networkLocation) : null;
    pending.finish(parseDeviceLocation(body?.position) ?? network ?? failure ?? null);
    return true;
  }
}

export function asksForCurrentLocation(text: string): boolean {
  const question = text.normalize("NFKC").trim().replace(/[\s?!.。！？]+$/u, "");
  return /^(?:请(?:问|告诉我)?[，, ]*)?(?:我(?:现在|現在|目前)?(?:在|身在)(?:哪(?:儿|兒|里|裡|个城市|個城市)?|什么地方|什麼地方)|(?:查(?:一下)?|获取|取得|告诉我|告訴我)?我的(?:当前|當前|目前|现在|現在|实时|即時)?(?:位置|定位))$/u.test(question.replace(/\s+/gu, "")) ||
    /^(?:please\s+)?(?:where am i(?: (?:right now|now|currently))?|(?:what is|what's|show me|can you tell me) my (?:current )?location)$/iu.test(question);
}

export async function resolveDeviceAddress(
  location: DeviceLocation, signal: AbortSignal, key = process.env.OMB_GOOGLE_GEOCODING_API_KEY, fetchAddress = fetch,
): Promise<DeviceLocation> {
  if (location.address || !key || signal.aborted) return location;
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${location.latitude},${location.longitude}`);
  url.searchParams.set("key", key);
  if (location.accuracy > 50) {
    const area = "locality|administrative_area_level_2|administrative_area_level_1";
    url.searchParams.set("result_type", location.accuracy <= 500 ? `neighborhood|sublocality|${area}` : area);
  }
  try {
    const response = await fetchAddress(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), redirect: "error" });
    if (!response.ok) return location;
    const body = await response.json() as { status?: unknown; results?: Array<{ formatted_address?: unknown }> } | null;
    const address = body?.status === "OK" ? cleanLocationAddress(body.results?.[0]?.formatted_address) : undefined;
    return address ? { ...location, address, addressSource: "google" } : location;
  } catch {
    return location;
  }
}

export function locationFailureMessage(reason: LocationFailure | null): string {
  switch (reason) {
    case "permission-denied": return "The device denied location access. Check its location permissions.";
    case "position-timed-out": return "The device did not obtain a location fix in time. Try again.";
    case "page-hidden": return "The page that sent this request was not active in the foreground. Switch back to it and try again.";
    case "position-unavailable": return "The device could not obtain a location fix.";
    default: return "The device did not return a usable location. The page may be disconnected or the fix may be invalid.";
  }
}

export function currentLocationNote(location: LocationResult): string {
  if (!location || typeof location === "string") {
    return `\n\n[Device location: unavailable for this request. ${locationFailureMessage(location)} Relay this explanation. Do not infer it from a time zone, the server location, or the chat.]`;
  }
  if ("source" in location) {
    return `\n\n[Approximate IP location from DB-IP: ${JSON.stringify(location)}. Device coordinates were unavailable. State that this is an estimate of the network exit, which may differ from the user's physical location, especially with a VPN or mobile network. Use the most specific named area supplied. Any postal code or network center is an estimate for the network, not the person. Do not reverse geocode the network center or infer a street or building. Credit DB-IP.]`;
  }
  return `\n\n[Current device location data: ${JSON.stringify(location)}. Answer from this reading. An address is a map match, not confirmation of a building or venue. Qualify it using the location accuracy. If no address is available, state that and give the coordinates. Do not send these coordinates to web search or infer a place from the time zone.]`;
}

export function createDeviceLocationHost(
  clients: Iterable<{ locationClient?: string; backpressured: boolean; sessionId?: string; res: ServerResponse }>,
  sessionLive: (id: string) => boolean,
) {
  const deviceLocations = new DeviceLocations();

  const locationPrefetches = new Map<string, AbortController>();

  function locationConnection(threadId: string, sendId: string | undefined) {
    const key = sendId ? deviceLocations.clientFor(threadId, sendId) : undefined;
    return key ? [...clients].find(client => client.locationClient === key && !client.backpressured &&
      (!client.sessionId || sessionLive(client.sessionId))) : undefined;
  }

  async function readCurrentDeviceLocation(connection: NonNullable<ReturnType<typeof locationConnection>>, signal: AbortSignal) {
    if (!connection.locationClient || connection.res.closed) return null;
    const closed = new AbortController();
    const abort = () => closed.abort();
    connection.res.once("close", abort);
    try {
      const requestSignal = AbortSignal.any([signal, closed.signal]);
      const fix = await deviceLocations.request(connection.locationClient, frame => connection.res.write(frame), requestSignal);
      if (requestSignal.aborted) return null;
      if (!fix || typeof fix === "string" || "source" in fix) return fix;
      const location = await resolveDeviceAddress(fix, requestSignal);
      return requestSignal.aborted ? null : location;
    } finally {
      connection.res.off("close", abort);
    }
  }

  async function locateForExplicitQuestion(threadId: string, sendId: string | undefined, generation: string) {
    const connection = locationConnection(threadId, sendId);
    if (!connection) return currentLocationNote(null);
    const controller = new AbortController();
    locationPrefetches.set(generation, controller);
    try {
      return currentLocationNote(await readCurrentDeviceLocation(connection, controller.signal));
    } finally {
      locationPrefetches.delete(generation);
    }
  }

  function bindLocationClient(req: IncomingMessage, auth: RequestAuth, threadId: string, sendId: string) {
    const key = locationClientKey(auth, req.headers[DEVICE_LOCATION_HEADER]);
    if (key) deviceLocations.bind(key, threadId, sendId);
  }
  return { deviceLocations, locationPrefetches, locationConnection, readCurrentDeviceLocation, locateForExplicitQuestion, bindLocationClient };
}
