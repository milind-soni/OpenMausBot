// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));
const { VaultChoices } = await import("./VaultChoices");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(kind: "secret" | "login") {
  await act(async () => root.render(createElement(VaultChoices, { kind, botId: "pepper", botName: "Pepper", threadId: "t 1", messageId: "m1" })));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Use a saved one on a secure card", () => {
  it("lists what could fit by name, and picking one answers the card with it", async () => {
    fixture.api.mockResolvedValueOnce({ choices: [{ id: "s1", name: "STRIPE_LIVE_KEY" }, { id: "1password:v1:i1#Stripe", name: "Stripe", provider: "1password" }] }).mockResolvedValueOnce({ provided: true });
    await render("secret");
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/pepper/secret-cards/m1/saved?threadId=t%201");
    const box = host.querySelector('[data-vault-choices="secret"]')!;
    expect(box.textContent).toBe("Use a saved oneSTRIPE_LIVE_KEYStripe· 1PasswordPepper can use the one you pick from now on.");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-vault-choice="s1"]')!.click());
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/bots/pepper/secret-cards/m1/use", { method: "POST", body: JSON.stringify({ threadId: "t 1", itemId: "s1" }) });
  });

  it("asks the sign-in card's own paths for a saved login", async () => {
    fixture.api.mockResolvedValueOnce({ choices: [{ id: "l1", name: "ops@example.com" }] }).mockResolvedValueOnce({ done: true });
    await render("login");
    expect(host.textContent).toContain("Use a saved login");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-vault-choice="l1"]')!.click());
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/bots/pepper/sign-in-cards/m1/use-login", { method: "POST", body: JSON.stringify({ threadId: "t 1", loginId: "l1" }) });
  });

  it("shows nothing when nothing fits or this person may not change the Vault", async () => {
    fixture.api.mockResolvedValueOnce({ choices: [] });
    await render("secret");
    expect(host.innerHTML).toBe("");
    fixture.api.mockRejectedValueOnce(new Error("admin only"));
    await render("login");
    expect(host.innerHTML).toBe("");
  });

  it("says why a pick failed, so the person can type it instead", async () => {
    fixture.api.mockResolvedValueOnce({ choices: [{ id: "s1", name: "Stripe" }] }).mockRejectedValueOnce(new Error("That saved secret is gone."));
    await render("secret");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-vault-choice="s1"]')!.click());
    expect(host.querySelector("[role=alert]")!.textContent).toBe("That saved secret is gone.");
  });
});
