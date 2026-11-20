// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { deviceLocation, listenForDeviceLocation } from "./device-location";

const location = { latitude: 1.352123, longitude: 103.819812, accuracy: 30, timestamp: Date.now() };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reads a one-shot browser location without taking extra fields from the browser", async () => {
  const getCurrentPosition = vi.fn((success) => {
    success({ coords: { ...location, altitude: 15 }, timestamp: location.timestamp });
  });
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });

  await expect(deviceLocation()).resolves.toEqual(location);
  expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
    enableHighAccuracy: true, maximumAge: 0, timeout: 15_000,
  });
});

it("uses the native Mac bridge when available", async () => {
  const currentLocation = vi.fn().mockResolvedValue(location);
  vi.stubGlobal("ogb", { currentLocation });
  await expect(deviceLocation()).resolves.toEqual(location);
  expect(currentLocation).toHaveBeenCalledOnce();
});

it("propagates a browser denial without providing coordinates", async () => {
  const denied = { code: 1, message: "Denied" };
  vi.stubGlobal("navigator", { geolocation: {
    getCurrentPosition: (_success: unknown, reject: (reason: unknown) => void) => reject(denied),
  } });

  await expect(deviceLocation()).rejects.toEqual(denied);
});

it("reads a fresh position for each addressed event and sends it back to the server", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const currentLocation = vi.fn().mockResolvedValueOnce(location).mockResolvedValueOnce({ ...location, latitude: 2 });
  const send = vi.fn().mockResolvedValue(null);
  vi.stubGlobal("ogb", { currentLocation });
  vi.stubGlobal("fetch", send);
  const stream = new EventTarget();
  listenForDeviceLocation(stream as EventSource, "tab");
  expect(currentLocation).not.toHaveBeenCalled();
  for (const request of ["1", "2"]) stream.dispatchEvent(new MessageEvent("device-location", { data: request.repeat(36) }));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(currentLocation).toHaveBeenCalledTimes(2);
  expect(JSON.parse(send.mock.calls[1][1].body).position.latitude).toBe(2);
});

it("withholds the fix when the requesting tab loses focus before positioning completes", async () => {
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ogb", { currentLocation: async () => {
    focused.mockReturnValue(false);
    return location;
  } });
  const send = vi.fn().mockResolvedValue(null);
  vi.stubGlobal("fetch", send);
  const stream = new EventTarget();
  listenForDeviceLocation(stream as EventSource, "tab");
  stream.dispatchEvent(new MessageEvent("device-location", { data: "1".repeat(36) }));
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(JSON.parse(send.mock.calls[0][1].body).position).toBeNull();
});

it("tries the standard accuracy provider when the high accuracy fix times out", async () => {
  const getCurrentPosition = vi.fn()
    .mockImplementationOnce((_success, reject) => reject({ code: 3 }))
    .mockImplementationOnce(success => success({ coords: location, timestamp: location.timestamp }));
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
  await expect(deviceLocation()).resolves.toEqual(location);
  expect(getCurrentPosition).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Function), {
    enableHighAccuracy: false, maximumAge: 0, timeout: 8_000,
  });
});


it("retries when high accuracy returns an unusable fix through the success callback", async () => {
  const getCurrentPosition = vi.fn()
    .mockImplementationOnce(success => success({ coords: location, timestamp: Date.now() - 90_000 }))
    .mockImplementationOnce(success => success({ coords: location, timestamp: location.timestamp }));
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
  await expect(deviceLocation()).resolves.toEqual(location);
  expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  expect(getCurrentPosition.mock.calls[1][2]).toMatchObject({ enableHighAccuracy: false, maximumAge: 0 });
});

it("preserves the native location failure instead of treating every Mac error as no fix", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ogb", { currentLocation: vi.fn().mockResolvedValue("position-timed-out") });
  const send = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValue(null);
  vi.stubGlobal("fetch", send);
  const stream = new EventTarget();
  listenForDeviceLocation(stream as EventSource, "tab");
  stream.dispatchEvent(new MessageEvent("device-location", { data: "1".repeat(36) }));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(JSON.parse(send.mock.calls[1][1].body)).toMatchObject({
    position: null,
    failure: "position-timed-out",
  });
});

it("keeps high accuracy running after a temporary provider error and accepts its next fresh fix", async () => {
  const clearWatch = vi.fn();
  const watchPosition = vi.fn((success, failure) => {
    failure({ code: 2 });
    success({ coords: location, timestamp: Date.now() - 90_000 });
    success({ coords: location, timestamp: location.timestamp });
    return 17;
  });
  vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch } });

  await expect(deviceLocation()).resolves.toEqual(location);
  expect(watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
    enableHighAccuracy: true, maximumAge: 0, timeout: 15_000,
  });
  expect(clearWatch).toHaveBeenCalledExactlyOnceWith(17);
});

it("ends a standard position watch when the browser returns nothing", async () => {
  vi.useFakeTimers();
  try {
    const clearWatch = vi.fn();
    vi.stubGlobal("navigator", { geolocation: {
      getCurrentPosition: vi.fn((_success, failure) => failure({ code: 3 })),
      watchPosition: vi.fn().mockReturnValueOnce(17).mockReturnValueOnce(23),
      clearWatch,
    } });

    const rejected = expect(deviceLocation()).rejects.toMatchObject({ code: 3 });
    await vi.advanceTimersByTimeAsync(23_000);
    await rejected;
    expect(clearWatch.mock.calls).toEqual([[17], [23]]);
  } finally {
    vi.useRealTimers();
  }
});

it("starts standard positioning after the high-accuracy watch expires", async () => {
  vi.useFakeTimers();
  try {
    const timestamp = Date.now();
    const clearWatch = vi.fn();
    const watchPosition = vi.fn()
      .mockImplementationOnce((_success, failure) => { failure({ code: 2 }); return 17; })
      .mockImplementationOnce(success => {
        success({ coords: location, timestamp: Date.now() });
        return 23;
      });
    vi.stubGlobal("navigator", { geolocation: { watchPosition, clearWatch } });

    const result = deviceLocation();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toEqual({ ...location, timestamp: timestamp + 15_000 });
    expect(watchPosition).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: false, maximumAge: 0, timeout: 8_000,
    });
    expect(clearWatch.mock.calls).toEqual([[17], [23]]);
  } finally {
    vi.useRealTimers();
  }
});


it.each(["position-unavailable", "position-timed-out"])("falls back to the client IP after %s", async failure => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ogb", { currentLocation: async () => failure });
  const send = vi.fn().mockResolvedValueOnce(Response.json({
    ipAddress: "203.0.113.123", city: "Example City", stateProv: "Example State", countryName: "Example Country",
    district: "Example County", zipCode: "12345", latitude: 1.35, longitude: 103.82,
  })).mockResolvedValue(null);
  vi.stubGlobal("fetch", send);
  const stream = new EventTarget();
  listenForDeviceLocation(stream as EventSource, "tab");
  stream.dispatchEvent(new MessageEvent("device-location", { data: "1".repeat(36) }));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[0][0]).toBe("https://api.db-ip.com/v2/free/self");
  const body = JSON.parse(send.mock.calls[1][1].body);
  expect(body.networkLocation).toEqual({
    source: "ip", provider: "DB-IP", city: "Example City", region: "Example State", country: "Example Country",
    district: "Example County", postalCode: "12345", networkCenter: { latitude: 1.35, longitude: 103.82 },
  });
  expect(JSON.stringify(body)).not.toContain("203.0.113.123");
});

it.each(["permission-denied", "position-interrupted"])("skips IP lookup after the native result %s", async failure => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ogb", { currentLocation: async () => failure });
  const send = vi.fn().mockResolvedValue(null);
  vi.stubGlobal("fetch", send);
  const stream = new EventTarget();
  listenForDeviceLocation(stream as EventSource, "tab");
  stream.dispatchEvent(new MessageEvent("device-location", { data: "1".repeat(36) }));
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][0]).toBe("/api/device-location");
});

it.each(["prompt", "denied", "granted"] as const)("checks browser authorization (%s) before an IP lookup after both watches expire", async state => {
  vi.useFakeTimers();
  try {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("navigator", {
      geolocation: { watchPosition: vi.fn().mockReturnValue(17), clearWatch: vi.fn() },
      permissions: { query: vi.fn().mockResolvedValue({ state }) },
    });
    const send = vi.fn().mockImplementation(async (url: string) =>
      url.startsWith("https:") ? Response.json({ city: "Example City" }) : null);
    vi.stubGlobal("fetch", send);
    const stream = new EventTarget();
    listenForDeviceLocation(stream as EventSource, "tab");
    stream.dispatchEvent(new MessageEvent("device-location", { data: "1".repeat(36) }));

    await vi.advanceTimersByTimeAsync(23_000);
    expect(send.mock.calls.map(([url]) => url)).toEqual(state === "granted"
      ? ["https://api.db-ip.com/v2/free/self", "/api/device-location"]
      : ["/api/device-location"]);
  } finally {
    vi.useRealTimers();
  }
});
