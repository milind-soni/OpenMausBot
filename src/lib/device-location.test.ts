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
