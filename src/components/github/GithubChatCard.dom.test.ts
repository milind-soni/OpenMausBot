// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { GithubSignInStatus } from "../../../shared/github-sign-in";

const sent = vi.hoisted(() => [] as Array<{ path: string; init?: RequestInit }>);
const route = vi.hoisted(() => ({ refuse: false }));
vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    sent.push({ path, init });
    if (route.refuse && path.includes("/status")) {
      const { ApiError } = await import("@/state/api");
      throw new ApiError("This GitHub sign-in is someone else's.", 403);
    }
    return { connected: true };
  }),
}));

const { setLocale } = await import("@/lib/i18n");
const { createGithubSignInStore } = await import("@/lib/github-sign-in");
const { ApiError } = await import("@/state/api");
const { ConnectorCard } = await import("../ConnectorCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIGNED_OUT: GithubSignInStatus = { state: "signed-out", download: false };
const CODE: GithubSignInStatus = { state: "signing-in", code: "WDJB-MJHT", verificationUrl: "https://github.com/login/device", expiresAt: Date.now() + 900_000 };
const message = (status: "required" | "connected" = "required", extra = {}) => ({
  id: "m1", role: "bot", kind: "connector", at: 1, text: "Chief couldn't push to acme/site: GitHub isn't connected.",
  connector: { source: "github", slug: "github-sign-in", label: "GitHub", description: "Connect GitHub so Chief can push its work.", status, resumeKey: "github-1", ...extra },
}) as never;

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => { setLocale("en"); sent.length = 0; route.refuse = false; reads.length = 0; host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; });

const reads: string[] = [];
const cardStatusCalls = () => sent.filter((call) => call.path === "/api/bots/chief/connector-cards/m1/status?threadId=t1").length;

async function show(answers: Array<GithubSignInStatus | InstanceType<typeof ApiError>>, card = message(), starts: Array<GithubSignInStatus | InstanceType<typeof ApiError>> = [CODE]) {
  const store = createGithubSignInStore({
    api: async (path) => {
      reads.push(path);
      if (path.endsWith("/start")) { const next = starts.shift()!; if (next instanceof ApiError) throw next; return next; }
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof ApiError) throw next;
      return next;
    },
    timers: { set: () => null, clear: () => {} },
  });
  root = createRoot(host);
  // The chat's own ConnectorCard: a github card is drawn by the GitHub card.
  const { GithubChatCard } = await import("./GithubChatCard");
  await act(async () => { root!.render(createElement(ConnectorCard, { botId: "chief", threadId: "t1", message: card })); });
  await act(async () => { await Promise.resolve(); });
  if (!(card as { connector: { dismissed?: boolean } }).connector.dismissed && !route.refuse) {
    expect(host.querySelector("[data-github-connect], [data-ask-card]"), "ConnectorCard draws a github card as the GitHub card").toBeTruthy();
    expect(host.textContent).not.toContain("Connect securely");
  }
  sent.length = 0;
  await act(async () => { root!.render(createElement(GithubChatCard, { botId: "chief", threadId: "t1", message: card, store })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return store;
}
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label);

it("says what failed and connects GitHub in place: the code, GitHub's page, then Cancel", async () => {
  await show([SIGNED_OUT]);
  const card = host.querySelector("[data-ask-card='pending']")!;
  expect(card.textContent).toContain("Chief couldn't push to acme/site: GitHub isn't connected.");
  expect(card.textContent).toContain("Bots push code and open pull requests as you.");
  await act(async () => { button("Connect GitHub")!.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(host.querySelector("[data-github-code]")!.textContent).toBe("WDJB-MJHT");
  expect(host.querySelector<HTMLAnchorElement>("[data-github-open]")!.href).toBe("https://github.com/login/device");
  expect(button("Cancel")).toBeTruthy();
});

it("settles on the server and becomes one quiet line once GitHub is connected", async () => {
  await show([{ state: "signed-in", login: "octo", source: "mausbot", scopes: [], checkedAt: 1 }]);
  expect(host.querySelector("[data-ask-card='settled']")!.textContent).toContain("GitHub · Connected as @octo");
  expect(cardStatusCalls()).toBe(1);
});

it("Not now sets the card aside through the card's own route", async () => {
  await show([SIGNED_OUT]);
  await act(async () => { button("Not now")!.click(); await Promise.resolve(); });
  expect(sent.at(-1)).toMatchObject({ path: "/api/bots/chief/connector-cards/m1/dismiss", init: { method: "POST", body: JSON.stringify({ threadId: "t1" }) } });
});

it("shows nothing to someone whose sign-in it isn't, and nothing once set aside", async () => {
  await show([new ApiError("Sign in to this team's Cloud to connect your own GitHub.", 403)]);
  expect(host.innerHTML).toBe("");
  await act(async () => root!.unmount()); root = null; host.innerHTML = "";
  await show([SIGNED_OUT], message("required", { dismissed: true }));
  expect(host.innerHTML).toBe("");
});

it("asks again before it says connected: a sign-in revoked since Apps last looked shows Connect again", async () => {
  const answers: GithubSignInStatus[] = [{ state: "signed-in", login: "octo", source: "mausbot", scopes: [], checkedAt: 1 }];
  const store = createGithubSignInStore({ api: async () => answers[0], timers: { set: () => null, clear: () => {} } });
  const appsStillOpen = store.subscribe(() => {});
  await act(async () => { await Promise.resolve(); });
  expect(store.snapshot().status?.state).toBe("signed-in");
  answers[0] = { state: "invalid", login: "octo", source: "mausbot", reason: "revoked" };
  const { GithubChatCard } = await import("./GithubChatCard");
  root = createRoot(host);
  await act(async () => { root!.render(createElement(GithubChatCard, { botId: "chief", threadId: "t1", message: message(), store })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(host.querySelector("[data-ask-card='settled']")).toBeNull();
  expect(button("Connect again")).toBeTruthy();
  expect(host.textContent).toContain("GitHub sign-in stopped working.");
  expect(cardStatusCalls()).toBe(1);
  appsStillOpen();
});

it("is hidden when the card's own route says it is someone else's, though the viewer's own GitHub is signed out", async () => {
  route.refuse = true;
  await show([SIGNED_OUT]);
  expect(host.innerHTML).toBe("");
});

it("start refused: no Connect in the footer, the token's Connect is the one primary button", async () => {
  await show([SIGNED_OUT], message(), [new ApiError("Windows Credential Manager already holds a GitHub CLI sign-in", 409)]);
  await act(async () => { button("Connect GitHub")!.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(host.querySelector("[data-github-connect]")).toBeNull();
  await act(async () => { button("Paste a token instead")!.click(); });
  const primaries = [...host.querySelectorAll("button.ui-button-primary")];
  expect(primaries.map((candidate) => candidate.textContent)).toEqual(["Connect"]);
  expect(primaries[0]!.closest("[data-github-token-form]")).not.toBeNull();
});

it("an open card asks for the sign-in once; one set aside or already connected asks nothing", async () => {
  await show([SIGNED_OUT]);
  expect(reads.filter((path) => path.startsWith("/api/github/sign-in"))).toEqual(["/api/github/sign-in"]);
  for (const card of [message("required", { dismissed: true }), message("connected")]) {
    await act(async () => root!.unmount()); root = null; host.innerHTML = ""; reads.length = 0;
    await show([SIGNED_OUT], card);
    expect(reads).toEqual([]);
    expect(cardStatusCalls()).toBe(0);
  }
  expect(host.textContent).toContain("GitHub · Connected");
});
