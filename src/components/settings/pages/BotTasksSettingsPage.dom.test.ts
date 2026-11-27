// @vitest-environment happy-dom
// Bot tasks' settings: what each control sends to PATCH /api/config, which ones wait on another, and the token that is
// only ever written, never shown.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { botTasksPatchBody, botTasksStatus, type BotTasksPatch, type BotTasksStatus } from "@/lib/bot-tasks";
import { setLocale } from "@/lib/i18n";
import { BotTasksSettingsView } from "./BotTasksSettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let save: ReturnType<typeof vi.fn<(patch: BotTasksPatch) => Promise<void>>>;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  save = vi.fn(async () => {});
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settings = (over: Partial<BotTasksStatus> = {}) => ({ ...botTasksStatus(null), ...over });
const render = (value: BotTasksStatus) => act(() => root.render(createElement(BotTasksSettingsView, { settings: value, save })));
const $ = <T extends HTMLElement = HTMLButtonElement>(selector: string) => host.querySelector<T>(selector)!;
const toggle = (name: string) => $(`[data-bot-tasks-switch="${name}"]`);
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
});
const sent = () => save.mock.calls.map(([patch]) => JSON.parse(botTasksPatchBody(patch)));

describe("BotTasksSettingsView", () => {
  it("keeps everything but the main switch off until bot tasks are on", () => {
    render(settings());
    expect(toggle("enabled").disabled).toBe(false);
    for (const name of ["githubSync", "requireEvidenceForDone", "requireEvidenceForReview", "allowOutboundComments", "allowMerge"]) expect(toggle(name).disabled, name).toBe(true);
    expect($<HTMLInputElement>("[data-bot-tasks-poll]").disabled).toBe(true);
    expect(host.textContent).toContain("Turn on bot tasks first.");
  });

  it("lets GitHub settings follow sync, and merging follow posting", () => {
    render(settings({ enabled: true }));
    expect(toggle("githubSync").disabled).toBe(false);
    expect(toggle("requireEvidenceForDone").disabled).toBe(false);
    expect(toggle("allowOutboundComments").disabled).toBe(true);
    expect($<HTMLTextAreaElement>("[data-bot-tasks-repos] textarea").disabled).toBe(true);
    render(settings({ enabled: true, githubSync: true }));
    expect(toggle("allowOutboundComments").disabled).toBe(false);
    expect(toggle("allowMerge").disabled).toBe(true);
    render(settings({ enabled: true, githubSync: true, allowOutboundComments: true }));
    expect(toggle("allowMerge").disabled).toBe(false);
  });

  it("sends one field per switch, flipped", async () => {
    render(settings({ enabled: true, githubSync: true, allowOutboundComments: true }));
    await click(toggle("enabled"));
    await click(toggle("requireEvidenceForDone"));
    await click(toggle("allowMerge"));
    expect(sent()).toEqual([{ botTasks: { enabled: false } }, { botTasks: { requireEvidenceForDone: false } }, { botTasks: { allowMerge: true } }]);
  });

  it("saves the poll interval and the repo list as typed, cleaned", async () => {
    render(settings({ enabled: true, githubSync: true, repos: ["a/b"] }));
    const poll = $<HTMLInputElement>("[data-bot-tasks-poll]");
    type(poll, "0");
    expect(host.textContent).toContain("Enter a number of minutes from 1 to 1440.");
    type(poll, "15");
    await act(async () => { poll.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    const repos = $<HTMLTextAreaElement>("[data-bot-tasks-repos] textarea");
    type(repos, "a/b\nhttps://github.com/acme/gadgets\nnope");
    expect($("[data-bot-tasks-save-repos]").disabled).toBe(true);
    expect(host.textContent).toContain("Not a repository: nope");
    type(repos, "a/b\nhttps://github.com/acme/gadgets");
    await click($("[data-bot-tasks-save-repos]"));
    expect(sent()).toEqual([{ botTasks: { pollMinutes: 15 } }, { botTasks: { repos: ["a/b", "acme/gadgets"] } }]);
  });

  it("offers the GitHub CLI or a token kept in the Vault, and says the token is not in the config file", async () => {
    render(settings({ enabled: true, githubSync: true }));
    const choices = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => ["GitHub CLI", "Vault token"].includes(button.textContent ?? ""));
    expect(choices.map((button) => button.textContent)).toEqual(["GitHub CLI", "Vault token"]);
    expect(host.querySelector("[data-bot-tasks-token]"), "no token field while the CLI signs in").toBeNull();
    await click(choices[1]!);
    expect(sent()).toEqual([{ botTasks: { credential: "vault" } }]);
    render(settings({ enabled: true, githubSync: true, credential: "vault" }));
    const field = $("[data-bot-tasks-token]").textContent ?? "";
    expect(field).toContain("Vault");
    expect(field).toContain("never in the config file");
    expect($("[data-bot-tasks-token-state]").textContent).toBe("No token in the Vault");
  });

  it("writes the token without ever showing it, and removes it with null", async () => {
    render(settings({ enabled: true, githubSync: true, credential: "vault" }));
    expect($("[data-bot-tasks-token-state]").dataset.botTasksTokenState).toBe("unset");
    const input = $<HTMLInputElement>("[data-bot-tasks-token] input");
    expect(input.type).toBe("password");
    type(input, "  ghp_secret  ");
    await click($("[data-bot-tasks-save-token]"));
    expect(input.value).toBe("");
    render(settings({ enabled: true, githubSync: true, credential: "vault", githubTokenSet: true }));
    expect($("[data-bot-tasks-token-state]").dataset.botTasksTokenState).toBe("set");
    expect(host.textContent).not.toContain("ghp_secret");
    await click($("[data-bot-tasks-clear-token]"));
    expect(sent()).toEqual([{ botTasks: { githubToken: "ghp_secret" } }, { botTasks: { githubToken: null } }]);
  });

  it("says when a save failed and keeps the switch as the server has it", async () => {
    save.mockRejectedValueOnce(new Error("500"));
    render(settings());
    await click(toggle("enabled"));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Couldn't save. Try again.");
    expect(toggle("enabled").getAttribute("aria-checked")).toBe("false");
  });
});
