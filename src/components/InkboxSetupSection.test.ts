// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InkboxSetupSnapshot } from "../../shared/inkbox-setup";
import { InkboxSetupSection } from "./InkboxSetupSection";

const fixture = vi.hoisted(() => ({ bots: [{ id: "atlas", name: "Atlas", hidden: false }, { id: "hidden", name: "Hidden", hidden: true }] }));
vi.mock("@/state/store", async original => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { bots: fixture.bots } }) }));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {} }));
const idle: InkboxSetupSnapshot = { available: true, phase: "disconnected", canReconnect: false, deliveries: [] };
const paired: InkboxSetupSnapshot = { ...idle, phase: "awaiting_phone", botId: "atlas", ownerPhone: "+919876543210", canReconnect: true, pairing: { number: "+15551234567", connectText: "connect mausbot-123", smsLink: "sms:+15551234567?body=connect%20mausbot-123" } };
let snapshot: InkboxSetupSnapshot;
let host: HTMLDivElement;
let root: Root;
let posts: Array<{ path: string; body: unknown }>;
let copied: string[];
let copyFails: boolean;
let handleGet: () => Promise<Response>;
let handlePost: (path: string) => Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent === text)!;
const render = () => act(async () => root.render(createElement(InkboxSetupSection)));
const enter = async (label: string, value: string) => {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = () => act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  snapshot = structuredClone(idle); posts = []; copied = []; copyFails = false;
  vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => { if (copyFails) throw new Error("Clipboard unavailable"); copied.push(text); } } });
  fixture.bots = [{ id: "atlas", name: "Atlas", hidden: false }, { id: "hidden", name: "Hidden", hidden: true }];
  handlePost = async () => json(paired);
  handleGet = async () => json(snapshot);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined }); return handlePost(path); }
    return handleGet();
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("shows discovered channel availability without claiming unsupported channels are connected", async () => {
  snapshot = { ...paired, capabilitiesAvailable: true, resources: [
    { channel: "email", status: "ready", address: "atlas@example.test", reason: "Your bot can read and send email." },
    { channel: "sms", status: "needs_setup", reason: "Attach a phone number in Inkbox." },
    { channel: "whatsapp", status: "unavailable", reason: "Inkbox does not currently offer a WhatsApp API." },
  ] };
  await render();
  expect(host.textContent).toContain("What your bot can use");
  expect(host.textContent).toContain("atlas@example.test");
  expect(host.textContent).toContain("Needs setup");
  expect(host.textContent).toContain("WhatsApp");
  expect(host.textContent).toContain("Not supported");
  expect(host.textContent).not.toContain("Approvals and questions are answered in Mausbot");
  expect(host.querySelector('a[href="https://inkbox.ai/console"]')).not.toBeNull();
});
it("explains that a paused connection cannot use its discovered capabilities", async () => {
  snapshot = { ...paired, phase: "disconnected", capabilitiesAvailable: false,
    resources: [{ channel: "email", status: "ready", address: "atlas@example.test", reason: "Mailbox available." }] };
  await render();
  expect(host.textContent).toContain("Reconnect to let your bot use these channels");
  expect(host.textContent).not.toContain("Your bot can use these channels now");
});
it("labels an incomplete incoming preview without exposing its internal message identifier", async () => {
  snapshot = { ...paired, deliveries: [{ id: "event", sender: "sender@example.test", channel: "email", status: "recorded", text: "A partial email", previewState: "truncated", previewNotice: "Preview shortened. Ask your bot to read the full message.", reference: { channel: "email", messageId: "internal-message-id" } }] };
  await render();
  expect(host.textContent).toContain("A partial email");
  expect(host.textContent).toContain("Preview shortened. Ask your bot to read the full message.");
  expect(host.textContent).not.toContain("internal-message-id");
});
it("submits the selected bot and owner phone, clears the key while pending, then shows a local pairing QR", async () => {
  let finish!: (response: Response) => void;
  handlePost = () => new Promise(resolve => { finish = resolve; });
  await render();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.querySelector("select")!.textContent).toBe("Atlas");
  await enter("Inkbox API key", "secret-key"); await enter("Your phone number", "+919876543210");
  await submit();
  expect(posts).toEqual([{ path: "/api/inkbox/setup", body: { apiKey: "secret-key", botId: "atlas", ownerPhone: "+919876543210" } }]);
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(host.querySelector("fieldset")!.disabled).toBe(true);
  expect(host.innerHTML).not.toContain("secret-key");
  await act(async () => finish(json(paired)));
  expect(host.textContent).toContain("Waiting for your first message");
  expect(host.textContent).toContain("connect mausbot-123");
  expect(host.querySelector('a[href^="sms:"]')).toBeNull();
  expect(button("Copy connect message")).toBeDefined();
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
  expect(host.querySelector("img")).toBeNull();
});
it("shows observed delivery separately from transport readiness and pauses without deleting setup", async () => {
  snapshot = { ...paired, phase: "connected", deliveries: [{ id: "one", sender: "+919876543210", status: "processing" }] };
  handlePost = async () => json({ ...paired, phase: "disconnected", pairing: undefined });
  await render();
  expect(host.textContent).toContain("Your message reached Mausbot");
  expect(host.textContent).toContain("processing");
  await act(async () => button("Disconnect").click());
  expect(posts).toEqual([{ path: "/api/inkbox/setup/disconnect", body: undefined }]);
  expect(host.textContent).toContain("Disconnected");
  expect(button("Reconnect")).toBeDefined();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  handlePost = async () => json(paired);
  await act(async () => button("Reconnect").click());
  expect(posts[1]).toEqual({ path: "/api/inkbox/setup/reconnect", body: undefined });
});
it("explains desktop availability and an empty bot list without setup internals", async () => {
  snapshot = { ...idle, available: false }; await render();
  expect(host.textContent).toContain("desktop app");
  expect(host.querySelector("form")).toBeNull();
  expect(host.textContent).not.toMatch(/webhook|environment|tunnel/i);
  await act(async () => root.unmount()); root = createRoot(host);
  snapshot = idle; fixture.bots = []; await render();
  expect(host.textContent).toContain("Create a bot");
  expect(button("Connect").disabled).toBe(true);
});
it("keeps a safe provider error actionable without a false connected state or retained key", async () => {
  handlePost = async () => json({ error: "This identity is already connected elsewhere. Use an admin key to create a separate identity." }, 409);
  await render(); await enter("Inkbox API key", "secret-key"); await enter("Your phone number", "+919876543210"); await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("already connected elsewhere");
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(host.textContent).not.toContain("Your message reached Mausbot");
});
it("never renders a provider-supplied non-SMS pairing link or remote QR", async () => {
  snapshot = { ...paired, pairing: { ...paired.pairing!, smsLink: "https://untrusted.example/qr" } }; await render();
  expect(host.querySelector('a[href="https://untrusted.example/qr"]')).toBeNull();
  expect(host.querySelector('svg[role="img"]')).toBeNull();
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("connect mausbot-123");
});
it("keeps setup errors visible across status polling", async () => {
  vi.useFakeTimers();
  handlePost = async () => json({ error: "Use an admin key to create a separate identity." }, 409);
  await render(); await enter("Inkbox API key", "secret-key"); await enter("Your phone number", "+919876543210"); await submit();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Use an admin key");
});
it("rejects a phone without a country code and does not submit on repeated clicks", async () => {
  await render(); await enter("Inkbox API key", "secret-key"); await enter("Your phone number", "9876543210");
  expect(button("Connect").disabled).toBe(true); await submit(); expect(posts).toEqual([]);
  await enter("Your phone number", "+919876543210");
  let finish!: (response: Response) => void; handlePost = () => new Promise(resolve => { finish = resolve; });
  await submit(); await submit(); expect(posts).toHaveLength(1);
  await act(async () => finish(json(paired)));
});
it("polls for an actual owner message before confirming the phone connection", async () => {
  vi.useFakeTimers(); snapshot = paired; await render();
  expect(host.textContent).toContain("Waiting for your first message");
  expect(host.textContent).not.toContain("Your message reached Mausbot");
  snapshot = { ...paired, phase: "connected", deliveries: [{ id: "one", sender: "+919876543210", status: "sent", reply: "Hello!" }] };
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(host.textContent).toContain("Your message reached Mausbot"); expect(host.textContent).toContain("Hello!");
});

it("ignores an old status response after Disconnect finishes", async () => {
  vi.useFakeTimers(); snapshot = { ...paired, phase: "connected" }; await render();
  let finishRead!: (response: Response) => void;
  handleGet = () => new Promise(resolve => { finishRead = resolve; });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  handlePost = async () => json({ ...paired, phase: "disconnected", pairing: undefined });
  await act(async () => button("Disconnect").click());
  expect(host.textContent).toContain("Disconnected");
  await act(async () => finishRead(json({ ...paired, phase: "connected" })));
  expect(host.textContent).toContain("Disconnected");
  expect(host.textContent).not.toContain("Your message reached Mausbot");
  expect(button("Reconnect")).toBeDefined();
});
it("renders the QR and copies the connect message for the provider's Apple-compatible SMS URI", async () => {
  snapshot = { ...paired, pairing: { number: "+15555550123", connectText: "connect @maus-test", smsLink: "sms:+15555550123?&body=connect%20%40maus-test" } };
  await render();
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
  expect(host.querySelector('a[href^="sms:"]')).toBeNull();
  await act(async () => button("Copy connect message").click());
  expect(copied).toEqual(["connect @maus-test"]);
  expect(host.textContent).toContain("Connect message copied");
});
it.each(["error", "setting_up", "connecting"] as const)("allows disconnecting a configured %s state before credentials are ready", async phase => {
  snapshot = { ...paired, phase, canReconnect: false, pairing: undefined };
  handlePost = async () => json({ ...snapshot, phase: "disconnected" });
  await render();
  expect(button("Disconnect")).toBeDefined(); expect(button("Disconnect").disabled).toBe(false);
  await act(async () => button("Disconnect").click());
  expect(posts).toEqual([{ path: "/api/inkbox/setup/disconnect", body: undefined }]);
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
});
it("cancels an in-flight setup and ignores its late success", async () => {
  let finish!: (response: Response) => void;
  handlePost = path => path.endsWith("/disconnect") ? Promise.resolve(json(idle)) : new Promise(resolve => { finish = resolve; });
  await render(); await enter("Inkbox API key", "secret-key"); await enter("Your phone number", "+919876543210"); await submit();
  expect(button("Disconnect")).toBeDefined(); expect(button("Disconnect").disabled).toBe(false);
  await act(async () => button("Disconnect").click());
  await act(async () => finish(json(paired)));
  expect(host.textContent).toContain("Disconnected");
  expect(host.textContent).not.toContain("Waiting for your first message");
  expect(posts.map(post => post.path)).toEqual(["/api/inkbox/setup", "/api/inkbox/setup/disconnect"]);
});
it("can replace a disconnected saved connection while keeping reconnect available", async () => {
  snapshot = { ...paired, phase: "disconnected", pairing: undefined }; await render();
  expect(button("Reconnect")).toBeDefined();
  expect(button("Set up again")).toBeDefined();
  await act(async () => button("Set up again").click());
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(button("Reconnect")).toBeDefined();
  await enter("Inkbox API key", "replacement-key"); await enter("Your phone number", "+15555550199"); await submit();
  expect(posts).toEqual([{ path: "/api/inkbox/setup", body: { apiKey: "replacement-key", botId: "atlas", ownerPhone: "+15555550199" } }]);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});

it("shows a useful copy failure without losing the QR or connect text", async () => {
  snapshot = paired; copyFails = true; await render();
  await act(async () => button("Copy connect message").click());
  expect(copied).toEqual([]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
  expect(host.textContent).toContain("connect mausbot-123");
  expect(host.querySelector('svg[role="img"]')).not.toBeNull();
});
it.each([["auto", "Automatic"], ["ask", "Ask first"]] as const)("shows the channel approval preference %s and owner commands", async (approvalMode, label) => {
  snapshot = { ...paired, approvalMode };
  await render();
  expect(host.textContent).toContain(`Messaging approvals: ${label}`);
  expect(host.textContent).toContain("approve for me");
  expect(host.textContent).toContain("ask me first");
});
it("does not invent an approval preference while its connection is unavailable", async () => {
  snapshot = { ...paired, phase: "disconnected" };
  await render();
  expect(host.textContent).not.toContain("Messaging approvals: Ask first");
  expect(host.textContent).not.toContain("Messaging approvals: Automatic");
});
