// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://tenant-secret.mausbot.cloud/rooms/ROOM-ID-777?share-computer=COMPUTER-ID-123&utm_source=newsletter","settings":{"disableJavaScriptFileLoading":true,"disableJavaScriptEvaluation":true,"disableCSSFileLoading":true,"disableIframePageLoading":true}}
// The real posthog-js behind a recording network stub. One flow: posthog-js is a single instance per process.
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";

const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";
const STORED = `ph_${TOKEN}_posthog`;
const FIRST_PAGE = "https://first-tenant.mausbot.cloud/rooms/FIRST-ROOM?share-computer=FIRST-COMPUTER&utm_source=first-campaign";
const REFERRER = "https://referrer.example/search?q=SECRET-REFERRER";
const SECRETS = [
  "first-tenant", "FIRST-ROOM", "FIRST-COMPUTER", "first-campaign", "referrer.example", "SECRET-REFERRER",
  "tenant-secret", "ROOM-ID-777", "COMPUTER-ID-123", "newsletter",
];

const sent: Array<{ url: string; body: unknown }> = [];
const answer = (url: string) => {
  const json = url.includes("/flags") ? { flags: {}, errorsWhileComputingFlags: false } : { status: 1 };
  return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify(json), json: async () => json };
};
class RecordingXhr {
  readyState = 0;
  status = 0;
  responseText = "";
  withCredentials = false;
  onreadystatechange: (() => void) | null = null;
  private url = "";
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader() {}
  send(body?: unknown) {
    sent.push({ url: this.url, body });
    this.readyState = 4;
    this.status = 200;
    this.responseText = "{}";
    queueMicrotask(() => this.onreadystatechange?.());
  }
  abort() {}
}
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

// posthog-js reads these when its module loads, so they are in place before analytics.ts imports it.
vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
  const url = String((input as { url?: string })?.url ?? input);
  sent.push({ url, body: init?.body });
  return answer(url);
});
vi.stubGlobal("XMLHttpRequest", RecordingXhr);
Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: (url: string, body: unknown) => (sent.push({ url, body }), true) });
Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false });
Object.defineProperty(navigator, "userAgent", {
  configurable: true,
  get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
});
Object.defineProperty(document, "referrer", { configurable: true, value: REFERRER });
vi.stubGlobal("sessionStorage", memoryStorage());
// What an install that ran a build with save_referrer and save_campaign_params on still holds.
vi.stubGlobal("localStorage", memoryStorage({
  [STORED]: JSON.stringify({
    distinct_id: "01a140ba-9e71-7f25-a581-b39f69b5e934",
    $device_id: "01a140ba-9e71-7f25-a581-b39f69b5e934",
    $user_state: "anonymous",
    $initial_person_info: { r: REFERRER, u: FIRST_PAGE },
    $initial_referrer_info: { $referrer: REFERRER, $referring_domain: "referrer.example" },
    $initial_campaign_params: { utm_source: "first-campaign" },
  }),
}));
// PostHog's CDN config for this project, as posthog-js would have loaded it.
(window as unknown as Record<string, unknown>)._POSTHOG_REMOTE_CONFIG = {
  [TOKEN]: {
    config: {
      analytics: { endpoint: "/i/v0/e/" }, hasFeatureFlags: false, sessionRecording: false, surveys: false, heatmaps: false,
      productTours: false, conversations: false, captureDeadClicks: false, autocaptureExceptions: false, siteApps: [],
      supportedCompression: ["gzip", "gzip-js"],
    },
  },
};

async function bodyText(body: unknown): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body.startsWith("data=") ? Buffer.from(decodeURIComponent(body.slice(5)), "base64").toString("utf8") : body;
  const bytes = Buffer.from(body instanceof Blob ? await body.arrayBuffer() : body as ArrayBuffer);
  return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
}

async function minutes(count: number) {
  for (let elapsed = 0; elapsed < count * 60; elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

it("sends events without any stored or current address, polls nothing, and sends nothing once switched off", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const analytics = await import("./analytics");
    await analytics.initAnalytics();
    analytics.track("app_snapshot", { bots: 3 });
    analytics.identifyEmail("person@example.com");
    await minutes(11);

    const urls = sent.map(({ url }) => new URL(url));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.map(({ origin, pathname }) => `${origin}${pathname}`).filter((url) => url !== "https://us.i.posthog.com/i/v0/e/")).toEqual([]);
    const bodies = await Promise.all(sent.map(({ body }) => bodyText(body)));
    expect(bodies.join("\n")).toContain("app_snapshot");
    expect(bodies.join("\n")).toContain("app_active");
    expect(bodies.join("\n")).toContain("$identify");
    expect(SECRETS.filter((secret) => bodies.some((body) => body.includes(secret)))).toEqual([]);
    const stored = JSON.parse(localStorage.getItem(STORED) ?? "{}") as Record<string, unknown>;
    for (const key of ["$initial_person_info", "$initial_referrer_info", "$initial_campaign_params"]) expect(stored).not.toHaveProperty(key);
    expect(document.querySelectorAll("script")).toHaveLength(0);

    const before = sent.length;
    analytics.setAnalyticsEnabled(false);
    analytics.track("after_off");
    await minutes(16);
    expect(sent.slice(before).map(({ url }) => url)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
