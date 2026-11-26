// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GithubSignInStatus } from "../../../shared/github-sign-in";
import { setLocale, t } from "@/lib/i18n";
import { createGithubSignInStore, type GithubSignInStore } from "@/lib/github-sign-in";
import { ApiError } from "@/state/api";
import en from "@/locales/en.json";
import { GithubAppCard } from "./GithubAppCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIGNED_OUT: GithubSignInStatus = { state: "signed-out", download: false };
const CODE: GithubSignInStatus = { state: "signing-in", code: "wdjbmjht", verificationUrl: "https://github.com/login/device", expiresAt: Date.now() + 900_000 };

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The card against a fake server that answers each path from its queue, the last answer repeating. */
async function show(answers: Record<string, Array<GithubSignInStatus | ApiError>>) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const timers: Array<() => void> = [];
  const store: GithubSignInStore = createGithubSignInStore({
    api: async (path, init) => {
      calls.push({ path, body: init?.body });
      const queue = answers[path.replace(/\?.*$/, "")] ?? [];
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (!next) throw new Error(`unexpected ${path}`);
      if (next instanceof ApiError) throw next;
      return next;
    },
    timers: { set: (fn) => { timers.push(fn); return fn; }, clear: (fn) => { const at = timers.indexOf(fn as () => void); if (at >= 0) timers.splice(at, 1); } },
  });
  root = createRoot(host);
  await act(async () => { root!.render(createElement(GithubAppCard, { store })); });
  await act(async () => { await Promise.resolve(); });
  const poll = async () => { const due = timers.splice(0); await act(async () => { for (const fn of due) fn(); await Promise.resolve(); }); };
  return { store, calls, timers, poll };
}
const card = () => host.querySelector<HTMLElement>("[data-app-tile='github-sign-in']");
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label);
const click = async (element: HTMLElement | undefined | null) => { await act(async () => { element!.click(); await Promise.resolve(); await Promise.resolve(); }); };

describe("the GitHub row in Apps", () => {
  it("not connected: one line and Connect; the download is said only when there is one; a quiet note after an expired code", async () => {
    const { timers } = await show({ "/api/github/sign-in": [SIGNED_OUT] });
    expect(card()!.dataset.githubState).toBe("signed-out");
    expect(card()!.textContent).toContain("Bots push code and open pull requests as you.");
    expect(card()!.textContent).toContain("GitHub sign-in");
    expect(card()!.textContent).not.toContain("15 MB");
    expect(button("Connect")).toBeTruthy();
    expect(timers).toEqual([]);
    await act(async () => root!.unmount()); root = null; host.innerHTML = "";

    await show({ "/api/github/sign-in": [{ state: "signed-out", download: true, last: { outcome: "expired", at: 1 } }] });
    expect(card()!.textContent).toContain("Connecting first downloads GitHub's command-line tool (about 15 MB).");
    expect(host.querySelector("[data-github-last='expired']")!.textContent).toBe("The last code expired before it was approved.");
  });

  it("Connect → preparing → the code to type, with a copy button and GitHub's own page, then signed in; polling ends there", async () => {
    const { calls, timers, poll } = await show({
      "/api/github/sign-in": [SIGNED_OUT, CODE, { state: "signed-in", login: "octo", source: "mausbot", scopes: ["repo"], orgs: ["acme"], checkedAt: 1 }],
      "/api/github/sign-in/start": [{ state: "installing" }],
    });
    await click(button("Connect"));
    expect(calls.map((call) => call.path)).toContain("/api/github/sign-in/start");
    expect(card()!.dataset.githubState).toBe("installing");
    expect(card()!.textContent).toContain("Getting GitHub sign-in ready…");
    expect(button("Cancel")).toBeTruthy();
    expect(timers).toHaveLength(1);

    await poll();
    expect(card()!.dataset.githubState).toBe("signing-in");
    expect(host.querySelector("[data-github-code]")!.textContent).toBe("WDJB-MJHT");
    expect(host.querySelector("[data-github-code]")!.getAttribute("aria-hidden")).toBe("true");
    expect(card()!.textContent).toContain("One-time code: W D J B, M J H T");
    expect(button("Copy code")).toBeTruthy();
    const open = host.querySelector<HTMLAnchorElement>("[data-github-open]")!;
    expect(open.textContent).toBe("Copy code & open GitHub");
    expect(open.getAttribute("href")).toBe("https://github.com/login/device");
    expect(open.target).toBe("_blank");
    expect(open.rel).toContain("noopener");
    expect(card()!.textContent).toContain("Or open github.com/login/device on any device.");
    expect(host.querySelector("[role='status']")!.textContent).toMatch(/^Waiting for approval · code expires at \d{1,2}:\d{2}/);
    expect(timers).toHaveLength(1);

    await poll();
    expect(card()!.dataset.githubState).toBe("signed-in");
    expect(card()!.textContent).toContain("Connected as @octo");
    expect(card()!.textContent).toContain("Signed in here · Organizations: acme");
    expect(host.querySelector<HTMLAnchorElement>("a[href='https://github.com/settings/applications']")!.textContent).toBe("Manage on GitHub");
    expect(button("Disconnect")).toBeTruthy();
    expect(timers).toEqual([]);
  });

  it("copies exactly the code when the open button is used", async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
    vi.spyOn(window, "open").mockReturnValue(null);
    await show({ "/api/github/sign-in": [CODE] });
    const open = host.querySelector<HTMLAnchorElement>("[data-github-open]")!;
    open.addEventListener("click", (event) => event.preventDefault());
    await click(open);
    expect(write).toHaveBeenCalledWith("WDJB-MJHT");
  });

  it("never draws a link to anywhere but GitHub's device page, though the code still shows", async () => {
    await show({ "/api/github/sign-in": [{ ...CODE, verificationUrl: "https://github.com.evil.example/login/device" }] as GithubSignInStatus[] });
    expect(host.querySelector("[data-github-code]")!.textContent).toBe("WDJB-MJHT");
    expect(host.querySelector("[data-github-open]")).toBeNull();
    expect(host.querySelector("a[href*='evil']")).toBeNull();
    expect(card()!.textContent).not.toContain("evil");
  });

  it("Cancel ends the wait and says so quietly", async () => {
    const { timers } = await show({ "/api/github/sign-in": [CODE], "/api/github/sign-in/cancel": [{ ...SIGNED_OUT, last: { outcome: "cancelled", at: 1 } }] });
    expect(timers).toHaveLength(1);
    await click(button("Cancel"));
    expect(card()!.dataset.githubState).toBe("signed-out");
    expect(card()!.textContent).toContain("The last sign-in was cancelled.");
    expect(timers).toEqual([]);
  });

  it("the person's own GitHub CLI: no Disconnect, and one line on how to sign out of it there", async () => {
    await show({ "/api/github/sign-in": [{ state: "signed-in", login: "octo", source: "cli", scopes: [], checkedAt: null }] });
    expect(card()!.textContent).toContain("Using your GitHub CLI");
    expect(host.querySelector("[data-github-cli-reason]")!.textContent).toContain("gh auth logout");
    expect(button("Disconnect")).toBeUndefined();
  });

  it("a pasted token: managed on GitHub's tokens page, and Disconnect signs it out", async () => {
    const { calls } = await show({
      "/api/github/sign-in": [{ state: "signed-in", login: "octo", source: "token", scopes: [], checkedAt: 1 }],
      "/api/github/sign-in/sign-out": [SIGNED_OUT],
    });
    expect(card()!.textContent).toContain("Using a token you pasted");
    expect(host.querySelector("a[href='https://github.com/settings/personal-access-tokens']")).toBeTruthy();
    await click(button("Disconnect"));
    expect(calls.at(-1)!.path).toBe("/api/github/sign-in/sign-out");
    expect(card()!.dataset.githubState).toBe("signed-out");
  });

  it("no longer valid: says bots can't push, and Connect again starts a new sign-in", async () => {
    const { calls } = await show({
      "/api/github/sign-in": [{ state: "invalid", login: "octo", source: "mausbot", reason: "revoked" }],
      "/api/github/sign-in/start": [CODE],
    });
    expect(card()!.textContent).toContain("GitHub sign-in stopped working. Bots can't push until you connect again.");
    await click(button("Connect again"));
    expect(calls.at(-1)!.path).toBe("/api/github/sign-in/start");
    expect(card()!.dataset.githubState).toBe("signing-in");
  });

  it("start refused: one line, then a masked token field that is emptied on submit, never echoed, never logged", async () => {
    const token = "github_pat_11AAAAAAA0secretsecretsecretsecret";
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { calls } = await show({
      "/api/github/sign-in": [SIGNED_OUT],
      "/api/github/sign-in/start": [new ApiError("This computer's Windows Credential Manager already holds a GitHub CLI sign-in", 409)],
      "/api/github/sign-in/token": [new ApiError(`GitHub did not accept ${token}`, 400)],
    });
    await click(button("Connect"));
    expect(host.querySelector("[data-github-refused]")!.textContent).toContain("A new GitHub sign-in can't start here.");
    expect(host.querySelector("[data-github-connect]"), "starting again gets the same refusal").toBeNull();
    expect(host.querySelector("a[href='https://github.com/settings/personal-access-tokens/new']")).toBeNull();
    await click(button("Paste a token instead"));
    const field = host.querySelector<HTMLInputElement>("input[name='github-token']")!;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");
    expect(field.getAttribute("aria-label")).toBe("GitHub token");
    expect(host.querySelector("a[href='https://github.com/settings/personal-access-tokens/new']")!.textContent!.trim()).toBe("Create a fine-grained token on GitHub");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, token);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { host.querySelector<HTMLFormElement>("[data-github-token-form]")!.requestSubmit(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.at(-1)).toEqual({ path: "/api/github/sign-in/token", body: JSON.stringify({ token }) });
    expect(host.querySelector<HTMLInputElement>("input[name='github-token']")!.value).toBe("");
    expect(host.querySelector("[role='alert']")!.textContent).toBe("GitHub didn't accept this token. Check it and paste it again.");
    expect(host.innerHTML).not.toContain(token);
    for (const spy of logs) for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain(token);
  });

  it("asks GitHub again when Apps' refresh is pressed, and reads again each time a card comes back into view", async () => {
    const { calls, store } = await show({ "/api/github/sign-in": [SIGNED_OUT] });
    expect(calls.map((call) => call.path)).toEqual(["/api/github/sign-in"]);
    await act(async () => { root!.render(createElement(GithubAppCard, { store, refreshKey: 1 })); await Promise.resolve(); });
    expect(calls.map((call) => call.path)).toEqual(["/api/github/sign-in", "/api/github/sign-in?check=1"]);
    await act(async () => root!.unmount());
    root = createRoot(host);
    await act(async () => { root!.render(createElement(GithubAppCard, { store })); await Promise.resolve(); });
    expect(calls).toHaveLength(3);
  });

  it("shows nothing at all to a person this sign-in isn't for", async () => {
    await show({ "/api/github/sign-in": [new ApiError("Sign in to this team's Cloud to connect your own GitHub.", 403)] });
    expect(host.innerHTML).toBe("");
  });

  it("offers Retry when the status could not be read", async () => {
    const { calls } = await show({ "/api/github/sign-in": [new ApiError("offline", 502), SIGNED_OUT] });
    await click(button("Retry"));
    expect(calls).toHaveLength(2);
    expect(card()!.dataset.githubState).toBe("signed-out");
  });
});

describe("its words", () => {
  it("are in every language the app ships, with the same placeholders", async () => {
    const { localePacks } = await import("@/locales");
    const keys = Object.keys(en).filter((key) => key.startsWith("githubSignIn.") || key.startsWith("server.github.card."));
    expect(keys.length).toBeGreaterThan(30);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const name of new Set(Object.values(localePacks))) {
      if (name === "en") continue;
      const pack = (await import(`../../locales/${name}.json`)).default as Record<string, string>;
      for (const key of keys) {
        expect(pack[key], `${name} ${key}`).toBeTruthy();
        expect(placeholders(pack[key]!), `${name} ${key}`).toEqual(placeholders((en as Record<string, string>)[key]!));
      }
    }
    setLocale("pt-br");
    expect(t("githubSignIn.pitch")).toBe("Os bots enviam código e abrem pull requests em seu nome.");
  });
});
