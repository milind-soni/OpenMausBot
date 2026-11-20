import { afterEach, expect, it, vi } from "vitest";
import { api } from "../state/api";
import { hasWebPush, syncWebPush } from "./web-push";

vi.mock("../state/api", () => ({ api: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("registers the service worker subscription, restores it on reopen and unsubscribes this device", async () => {
  const subscription = { endpoint: "https://web.push.apple.com/example", unsubscribe: vi.fn(async () => true), options: {} };
  let current: typeof subscription | null = null;
  const worker = { pushManager: {
    getSubscription: async () => current,
    subscribe: vi.fn(async () => current = subscription),
  } };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }), PushManager: {}, Notification: {} });
  vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn(), ready: Promise.resolve(worker), getRegistration: async () => worker } });
  vi.mocked(api).mockResolvedValue({ publicKey: "key" });
  await syncWebPush(true);
  await syncWebPush(true);
  expect(worker.pushManager.subscribe).toHaveBeenCalledExactlyOnceWith({ userVisibleOnly: true, applicationServerKey: "key" });
  expect(api).toHaveBeenCalledWith("/api/push/web", { method: "PUT", body: JSON.stringify({ subscription, silent: false }) });
  expect(hasWebPush()).toBe(true);
  await syncWebPush(false);
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledWith("/api/push/web", { method: "DELETE" });
  expect(hasWebPush()).toBe(false);
});
