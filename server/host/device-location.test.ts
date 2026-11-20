import { describe, expect, it, vi } from "vitest";
import type { RequestAuth } from "../request-auth.ts";
import { asksForCurrentLocation, currentLocationNote, DeviceLocations, locationClientKey, resolveDeviceAddress } from "./device-location.ts";

const tab = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const otherTab = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const local: RequestAuth = { kind: "loopback", scopes: ["client", "admin"] };
const point = { latitude: 1.352123, longitude: 103.819812, accuracy: 30 };

describe("device locations", () => {
  it("keeps the initiator across reconnects, and rejects rebinding to another tab", () => {
    const locations = new DeviceLocations();
    locations.bind(tab, "thread", "send");
    locations.bind(otherTab, "thread", "send");
    expect(locations.clientFor("thread", "send")).toBe(tab);
    expect(locations.clientFor("another", "send")).toBeUndefined();
  });

  it("accepts one reply from the bound tab and validates and rounds its coordinates", async () => {
    const locations = new DeviceLocations(), write = vi.fn();
    const waiting = locations.request(locationClientKey(local, tab)!, write, new AbortController().signal);
    const request = write.mock.calls[0][0].split("\n")[1].slice(6);
    const timestamp = Date.now();
    const body = { request, position: { ...point, timestamp } };
    expect(locations.reply(local, otherTab, body)).toBe(false);
    expect(locations.reply(local, tab, body)).toBe(true);
    expect(locations.reply(local, tab, body)).toBe(false);
    await expect(waiting).resolves.toEqual({ latitude: 1.35212, longitude: 103.81981, accuracy: 31, timestamp });
  });

  it("drops requests when the tool call ends and rejects expired fixes", async () => {
    const locations = new DeviceLocations(), controller = new AbortController(), write = vi.fn();
    const key = locationClientKey(local, tab)!;
    const waiting = locations.request(key, write, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeNull();
    const retry = locations.request(key, write, new AbortController().signal);
    const request = write.mock.calls[1][0].split("\n")[1].slice(6);
    expect(locations.reply(local, tab, { request, position: { ...point, timestamp: Date.now() - 90_000 } })).toBe(true);
    await expect(retry).resolves.toBeNull();
  });
});

it.each(["我在哪", "请问，我现在在哪儿？", "我目前在哪裡？", "查一下我的定位", "Where am I right now?", "What's my location?"])(
  "treats %s as an explicit physical location request",
  question => expect(asksForCurrentLocation(question)).toBe(true),
);

it.each(["你在哪", "我在哪个文件里", "把‘我在哪’翻译成英文", "where am I in the code?", "What time zone am I in?"])(
  "does not trigger device location for %s",
  question => expect(asksForCurrentLocation(question)).toBe(false),
);

it("passes only the measured fix to the model and prohibits guessing on failure", () => {
  expect(currentLocationNote({ ...point, timestamp: 0 })).toContain('"latitude":1.352123,"longitude":103.819812');
  expect(currentLocationNote(null)).toContain("Do not infer it from a time zone");
});

it("reverse geocodes a coarse fix at neighborhood scale without changing its accuracy", async () => {
  const fix = { ...point, accuracy: 170, timestamp: Date.now() };
  const lookup = vi.fn(async (url: URL) => {
    expect(url.searchParams.get("latlng")).toBe("1.352123,103.819812");
    expect(url.searchParams.get("result_type")).toContain("neighborhood");
    return Response.json({ status: "OK", results: [{ formatted_address: "Example neighborhood" }] });
  });
  const signal = new AbortController().signal;
  await expect(resolveDeviceAddress(fix, signal, "test-key", lookup as typeof fetch))
    .resolves.toEqual({ ...fix, address: "Example neighborhood", addressSource: "google" });
  const native = { ...fix, address: "Native address", addressSource: "apple" as const };
  await expect(resolveDeviceAddress(native, signal, "test-key", lookup as typeof fetch)).resolves.toBe(native);
  await expect(resolveDeviceAddress(fix, signal, "", lookup as typeof fetch)).resolves.toBe(fix);
  expect(lookup).toHaveBeenCalledOnce();
});

it("passes through the device failure without claiming permission was denied", async () => {
  const locations = new DeviceLocations(), write = vi.fn();
  const waiting = locations.request(locationClientKey(local, tab)!, write, new AbortController().signal);
  const request = write.mock.calls[0][0].split("\n")[1].slice(6);
  expect(locations.reply(local, tab, { request, failure: "position-timed-out" })).toBe(true);
  const note = currentLocationNote(await waiting);
  expect(note).toContain("did not obtain a location fix in time");
  expect(note).not.toContain("permission");
});

it("uses IP only for a failed device fix and labels it as the network exit", async () => {
  const places = new DeviceLocations(), key = locationClientKey(local, tab)!;
  for (const failure of ["position-unavailable", "permission-denied"] as const) {
    const write = vi.fn();
    const pending = places.request(key, write, new AbortController().signal);
    const request = write.mock.calls[0][0].split("\n")[1].slice(6);
    expect(places.reply(local, tab, { request, failure, networkLocation: { city: "Example", district: "Example County", postalCode: "12345", networkCenter: { latitude: 999, longitude: 51 }, ipAddress: "fake" } })).toBe(true);
    const result = await pending;
    if (failure === "permission-denied") {
      expect(result).toBe(failure);
    } else {
      expect(result).toEqual({ source: "ip", provider: "DB-IP", city: "Example", district: "Example County", postalCode: "12345" });
      expect(currentLocationNote(result)).toContain("network exit");
    }
  }
});
