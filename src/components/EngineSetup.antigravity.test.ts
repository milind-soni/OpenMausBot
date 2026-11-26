// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";

const antigravity: InstanceInfo = {
  instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Antigravity",
  models: { default: "gemini", options: [] },
  snapshot: { state: "available", authenticated: false, version: "1.1.1" },
  install: { managed: { label: "Install official Antigravity", downloadBytes: 1024 } },
  authentication: { method: "callback-url", signOut: true },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    auth: { phase: "pending", flowId: "flow-1", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" },
  }), { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function auth(body: object) {
  return new Response(JSON.stringify({ auth: body }), { status: 200, headers: { "content-type": "application/json" } });
}

async function startSignIn(status: object, ogb: object = { remoteClient: { active: false } }, config: object = {}, started: object = {}) {
  const openExternal = vi.fn(async () => {});
  vi.stubGlobal("ogb", { platform: "linux", openExternal, ...ogb });
  const fetched = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/auth/status")
    ? auth(status)
    : auth({ phase: "waiting", flowId: "flow-1", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s", ...started }));
  vi.stubGlobal("fetch", fetched);
  const store = { state: { config }, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: antigravity }) })));
  const button = () => [...host.querySelectorAll("button")].find((b) => /Sign in with Google|Open Google sign-in again/.test(b.textContent ?? ""))!;
  button().click();
  await vi.waitFor(() => expect(host.querySelector("[data-redirect-paste], [data-code-paste]")).not.toBeNull());
  return { store, fetched, openExternal, button };
}

it("shows the paste-the-redirect field the whole time the card waits, on the person's own computer too", async () => {
  await startSignIn({ phase: "waiting", flowId: "flow-1" });
  const field = host.querySelector<HTMLInputElement>("[data-redirect-paste] input")!;
  expect(field.getAttribute("aria-label")).toBeTruthy();
  expect(host.querySelector("details")).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  expect(host.querySelector("[data-redirect-paste] input")).not.toBeNull();
  // The pinned runtime's sign-in (the default; the native CLI is opt-in) shows no code field, as before it.
  expect(host.querySelector("[data-code-paste]")).toBeNull();
  expect(host.textContent).not.toContain("Code from the Antigravity page");
  expect(host.textContent).toContain("I finished signing in");
}, 15_000);

it("opens the same Google link again instead of starting another sign-in", async () => {
  const { fetched, openExternal, button } = await startSignIn({ phase: "waiting", flowId: "flow-1" });
  await vi.waitFor(() => expect(button().textContent).toContain("Open Google sign-in again"));
  button().click();
  await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
  expect(fetched.mock.calls.filter(([input]) => String(input).includes("/auth/start"))).toHaveLength(1);
});

it("says the sign-in expired and offers to start again, once the server reports it", async () => {
  const { button } = await startSignIn({ phase: "expired", flowId: "flow-1", message: "Google sign-in expired. Start sign-in again." });
  await vi.waitFor(() => expect(host.textContent).toContain("Google sign-in expired. Start again."), { timeout: 6_000 });
  expect(host.querySelector("[data-redirect-paste]")).toBeNull();
  expect(button().textContent).toContain("Sign in with Google");
}, 15_000);

it("shows the server's fixed reason when the sign-in fails", async () => {
  await startSignIn({ phase: "failed", flowId: "flow-1", message: "Google sign-in was not approved. Start sign-in again." });
  await vi.waitFor(() => expect(host.textContent).toContain("Google sign-in was not approved. Start sign-in again."), { timeout: 6_000 });
}, 15_000);

it("reads the engines and their models when the sign-in finishes by itself", async () => {
  const { store } = await startSignIn({ phase: "succeeded", flowId: "flow-1" });
  await vi.waitFor(() => expect(store.refreshModels).toHaveBeenCalledWith("antigravity"), { timeout: 6_000 });
  await vi.waitFor(() => expect(host.querySelector("[data-redirect-paste]")).toBeNull());
}, 15_000);

// A Cloud's person saw Google's last page fail on 127.0.0.1 and read it as a broken sign-in: on a Cloud the card says up front
// that this page won't load and that its address goes in the box, which it names for that.
const cloudHint = "After you sign in, Google opens a page that won’t load. Copy its address and paste it below.";

it("tells a Cloud's person, before they sign in, that Google's last page won't load and its address goes below", async () => {
  await startSignIn({ phase: "waiting", flowId: "flow-1" }, { remoteClient: { active: false } }, { cloudHome: true });
  expect(host.querySelector("[data-redirect-paste] p")?.textContent).toBe("Google’s page didn’t load? Paste its address here");
  const hint = [...host.querySelectorAll("p")].find((p) => p.textContent === cloudHint)!;
  expect(hint.nextElementSibling?.textContent).toContain("Open Google sign-in again");
});

it.each([false, true])("keeps the other-computer wording off a Cloud (paired to another computer: %s)", async (remote) => {
  await startSignIn({ phase: "waiting", flowId: "flow-1" }, { remoteClient: { active: remote } });
  expect(host.querySelector("[data-redirect-paste] p")?.textContent).toBe("Signing in from another computer?");
  expect(host.textContent).not.toContain(cloudHint);
});

it("names Google on the sign-in card, never another provider", () => {
  vi.stubGlobal("ogb", { platform: "linux", remoteClient: { active: false } });
  const store = { state: { config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: antigravity }) })));
  expect(host.textContent).toContain("Sign in with Google");
  expect(host.textContent).not.toContain("Mistral");
});

// The app starts the native CLI so each account keeps its own sign-in, as on the pinned runtime.
it("says each account has its own Google account on the sign-in card, on either runtime", () => {
  vi.stubGlobal("ogb", { platform: "linux", remoteClient: { active: false } });
  const store = { state: { config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  const render = (instance: InstanceInfo) => flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance }) })));
  for (const instance of [{ ...antigravity, cli: "antigravity", snapshot: { ...antigravity.snapshot, nativeCli: true as const } }, { ...antigravity, cli: "agy" }]) {
    render(instance);
    expect(host.textContent).toContain("has its own Google account");
    expect(host.textContent).not.toContain("keeps one sign-in");
  }
});

it("describes and labels the install as Google's Antigravity CLI, unless the path asks for the pinned runtime alone", () => {
  vi.stubGlobal("ogb", { platform: "linux", remoteClient: { active: false } });
  const store = { state: { config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  const missing = { state: "unavailable" as const, reason: "The Antigravity CLI is not installed yet." };
  const render = (cli: string | undefined) => flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: { ...antigravity, cli, snapshot: missing } }) })));
  for (const cli of [undefined, "agy", "antigravity"]) {
    render(cli);
    expect(host.textContent).toContain("installs Google's Antigravity CLI");
    expect(host.textContent).toContain("Install Google Antigravity CLI");
    expect(host.textContent).not.toContain("separate from the Antigravity app and agy CLI");
  }
  render("agy_acp_server");
  expect(host.textContent).toContain("separate from the Antigravity app and agy CLI");
  expect(host.textContent).toContain("Install Classic runtime");
});

// The native CLI's sign-in ends on a page that shows a code, not on a redirect to this computer.
describe("a sign-in whose page ends on a code", () => {
  const native = { kind: "pasted-code", authorizationUrl: "https://accounts.google.com/o/oauth2/auth?state=s" };

  it("asks for the code or the page's address, and never for a redirect that cannot load or a finished button", async () => {
    await startSignIn({ phase: "waiting", flowId: "flow-1" }, { remoteClient: { active: false } }, { cloudHome: true }, native);
    expect(host.querySelector("[data-redirect-paste]")).toBeNull();
    expect(host.textContent).not.toContain("I finished signing in");
    expect(host.textContent).not.toContain("won’t load");
    expect(host.querySelector("[data-code-paste] p")?.textContent).toContain("paste the code it shows, or the full address of the page you end on");
    expect(host.querySelector("[data-code-paste] input")?.getAttribute("aria-label")).toBe("Sign-in code or page address");
  });

  it("sends what was pasted with the sign-in's id, then reads the engines again", async () => {
    const { store, fetched } = await startSignIn({ phase: "waiting", flowId: "flow-1" }, { remoteClient: { active: false } }, {}, native);
    const field = host.querySelector<HTMLInputElement>("[data-code-paste] input")!;
    const send = [...host.querySelectorAll("button")].find((b) => b.textContent === "Send code")!;
    expect(send.disabled).toBe(true);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => { setValue.call(field, "4/0AbcCode"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    flushSync(() => send.click());
    await vi.waitFor(() => expect(store.refreshModels).toHaveBeenCalledWith("antigravity"));
    const sent = (fetched.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>).find(([input]) => String(input).includes("/auth/complete"))!;
    expect(JSON.parse(String(sent[1].body))).toEqual({ flowId: "flow-1", callbackUrl: "4/0AbcCode" });
  });
});
