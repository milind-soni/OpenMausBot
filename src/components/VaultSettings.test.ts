// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), admin: true as boolean | null, config: null as { cloudHome?: boolean } | null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { bots: [{ id: "pepper", name: "Pepper" }, { id: "quill", name: "Quill" }], config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
const { VaultSettings } = await import("./VaultSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const CARD_LOGIN = { id: "l1", site: "example.com", hosts: ["example.com", "login.microsoftonline.com"], exactHost: false, username: "alice@example.com", hasTotp: true, source: "card", bots: ["pepper"], createdAt: 1, lastUsedAt: Date.now() - 120_000 };
const SHARED_LOGIN = { id: "l2", site: "example.org", hosts: ["crm.example.org"], exactHost: false, username: "team", hasTotp: false, source: "settings", bots: "all", createdAt: 2 };
const TENANT_LOGIN = { id: "l3", site: "okta.com", hosts: ["acme.okta.com"], exactHost: true, username: "ops", hasTotp: false, source: "settings", bots: "all", createdAt: 3 };
const VAULT_LOGIN = { id: "1password:v1:i1:example.com", site: "example.com", hosts: ["vault.example.com"], exactHost: false, username: "vault-user", hasTotp: false, source: "1password", bots: "all", createdAt: 0 };
const OFF = { connected: false };

beforeEach(() => {
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.admin = true;
  fixture.config = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => root.render(createElement(VaultSettings)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function type(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector<HTMLFormElement>("[data-login-form]")!.requestSubmit(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Settings → Vault: logins", () => {
  it("lists each login by site, the sign-in hosts it also fills on, username, 2FA, source, who may use it and last use", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN, SHARED_LOGIN, TENANT_LOGIN], onePassword: OFF });
    await render();
    expect(fixture.api).toHaveBeenCalledWith("/api/vault");
    const rows = [...host.querySelectorAll("[data-login-row]")].map((row) => row.textContent);
    expect(rows[0]).toContain("example.com");
    expect(rows[0]).toContain("alice@example.com");
    expect(rows[0]).toContain("Also signs in on login.microsoftonline.com");
    expect(rows[0]).toContain("2FA");
    expect(rows[0]).toContain("Saved from a chat · Pepper · Used 2 min ago");
    expect(rows[1]).toContain("Added here · All bots · Not used yet");
    expect(rows[1]).toContain("Also signs in on crm.example.org");
    expect(rows[2]).toContain("Only on acme.okta.com");
    expect(host.querySelector("[data-logins-list]")!.querySelectorAll("input")).toHaveLength(0);
  });

  it("adds a login for the bots chosen, and keeps nothing it was typed once saved", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [], onePassword: OFF }).mockResolvedValueOnce({ login: SHARED_LOGIN }).mockResolvedValueOnce({ logins: [SHARED_LOGIN], onePassword: OFF });
    await render();
    expect(host.textContent).toContain("Nothing saved yet.");
    await click("Add");
    await click("Add a login");
    await type("site", "crm.example.org");
    await type("username", "team");
    await type("password", "fake-typed-pass");
    await act(async () => { [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!.click(); });
    await act(async () => { host.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]')!.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins", { method: "POST", body: JSON.stringify({ site: "crm.example.org", username: "team", password: "fake-typed-pass", bots: ["pepper"] }) });
    expect(host.querySelector("[data-login-form]")).toBeNull();
    expect(host.innerHTML).not.toContain("fake-typed-pass");
  });

  it("keeps a new login to its exact address when asked", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [], onePassword: OFF }).mockResolvedValueOnce({ login: TENANT_LOGIN }).mockResolvedValueOnce({ logins: [TENANT_LOGIN], onePassword: OFF });
    await render();
    await click("Add");
    await click("Add a login");
    await type("site", "acme.okta.com");
    await type("password", "fake-tenant-pass");
    const exact = host.querySelector<HTMLInputElement>('input[name="exactHost"]')!;
    expect(exact.checked).toBe(false);
    expect(exact.closest("label")!.textContent).toBe("Only on this exact address, not elsewhere on its site");
    await act(async () => { exact.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins", { method: "POST", body: JSON.stringify({ site: "acme.okta.com", username: "", password: "fake-tenant-pass", bots: "all", exactHost: true }) });
  });

  it("replaces a password, keeps the 2FA key unless asked, and changes who may use it", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF }).mockResolvedValueOnce({ login: CARD_LOGIN }).mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF });
    await render();
    await click("Change the login for example.com");
    expect(host.querySelector<HTMLInputElement>('input[name="password"]')!.value).toBe("");
    await type("password", "fake-new-pass");
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "PATCH", body: JSON.stringify({ password: "fake-new-pass", bots: "all" }) });
  });

  it("keeps a login to its sign-in hosts, or lets it fill on its whole site again", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF }).mockResolvedValueOnce({ login: CARD_LOGIN }).mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF });
    await render();
    await click("Change the login for example.com");
    const exact = host.querySelector<HTMLInputElement>('input[name="exactHost"]')!;
    expect(exact.closest("label")!.textContent).toBe("Only on example.com, login.microsoftonline.com, not elsewhere on example.com");
    await act(async () => { exact.click(); });
    await submit();
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "PATCH", body: JSON.stringify({ bots: ["pepper"], exactHost: true }) });
  });

  it("deletes only on a second click", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [CARD_LOGIN], onePassword: OFF }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ logins: [], onePassword: OFF });
    await render();
    await click("Delete the login for example.com");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await click("Delete for good");
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/l1", { method: "DELETE" });
  });

  it("connects 1Password with a masked token it then forgets, lists its logins read-only, and disconnects", async () => {
    const on = { connected: true, vaults: [{ id: "v1", title: "Shared with OMB", items: 1, bots: "all" }], items: 1 };
    fixture.api
      .mockResolvedValueOnce({ logins: [], onePassword: OFF })
      .mockResolvedValueOnce({ onePassword: on })
      .mockResolvedValueOnce({ logins: [VAULT_LOGIN], onePassword: on })
      .mockResolvedValueOnce({ onePassword: OFF })
      .mockResolvedValueOnce({ logins: [], onePassword: OFF });
    await render();
    expect(host.querySelector("[data-onepassword]")!.textContent).toContain("create a service account that can read one vault only");
    const field = host.querySelector<HTMLInputElement>('input[name="onePasswordToken"]')!;
    expect(field.type).toBe("password");
    await type("onePasswordToken", "ops_fake-typed-token");
    await click("Connect 1Password");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/1password", { method: "POST", body: JSON.stringify({ token: "ops_fake-typed-token" }) });
    expect(host.querySelector("[data-onepassword]")!.textContent).toContain("Connected to Shared with OMB · 1 logins, keys and secrets");
    expect(host.innerHTML).not.toContain("ops_fake-typed-token");
    const row = host.querySelector('[data-login-row="example.com"]')!;
    expect(row.textContent).toContain("From 1Password · All bots");
    expect(row.querySelectorAll("button")).toHaveLength(0);
    await click("Disconnect");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenNthCalledWith(4, "/api/logins/1password", { method: "DELETE" });
    expect(host.querySelector<HTMLInputElement>('input[name="onePasswordToken"]')!.value).toBe("");
  });

  it("keeps a 1Password vault to the bots chosen for it, on the same screen", async () => {
    const vault = { id: "v1", title: "Shared with OMB", items: 2, bots: "all" };
    const on = { connected: true, vaults: [vault], items: 2 };
    const narrowed = { ...on, vaults: [{ ...vault, bots: ["quill"] }] };
    fixture.api
      .mockResolvedValueOnce({ logins: [VAULT_LOGIN], onePassword: on })
      .mockResolvedValueOnce({ onePassword: narrowed })
      .mockResolvedValueOnce({ logins: [{ ...VAULT_LOGIN, bots: ["quill"] }], onePassword: narrowed });
    await render();
    const row = () => host.querySelector('[data-vault="Shared with OMB"]')!;
    expect(row().textContent).toContain("2 logins · All bots");
    await click("Change who can use Shared with OMB");
    await act(async () => { [...row().querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!.click(); });
    await act(async () => { [...row().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!.click(); });
    await click("Save changes");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/logins/1password/vaults/v1", { method: "PATCH", body: JSON.stringify({ bots: ["quill"] }) });
    expect(row().textContent).toContain("2 logins · Quill");
    expect(host.querySelector('[data-login-row="example.com"]')!.textContent).toContain("From 1Password · Quill");
  });

  it("says why 1Password refused a token", async () => {
    fixture.api.mockResolvedValueOnce({ logins: [], onePassword: OFF }).mockRejectedValueOnce(new Error("1Password did not accept the token."));
    await render();
    await type("onePasswordToken", "ops_fake-wrong");
    await click("Connect 1Password");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector("[data-onepassword] [role=alert]")!.textContent).toBe("1Password did not accept the token.");
  });

  it("is for admins only", async () => {
    fixture.admin = false;
    await render();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Only an admin of this installation can see and change the Vault.");
  });
});

describe("Settings → Vault: keys and secrets", () => {
  const SAVED = { id: "s1", name: "Stripe secret key", source: "card", bots: ["pepper"], createdAt: 1, updatedAt: 1 };
  const LINKED = { id: "1password:v1:i9", name: "Notion token", fields: [], source: "linked", provider: "1password", bots: "all", readOnly: true };
  const listed = (secrets: unknown[] = [SAVED, LINKED]) => ({ logins: [CARD_LOGIN], secrets, onePassword: OFF });
  const shown = () => [...host.querySelectorAll("[data-login-row], [data-secret-row]")].map((row) => row.getAttribute("data-login-row") ?? row.getAttribute("data-secret-row"));
  async function fill(selector: string, value: string) {
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function send(form: string) {
    await act(async () => { host.querySelector<HTMLFormElement>(`[data-${form}]`)!.requestSubmit(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("lists saved and linked secrets beside logins by name only, and finds them by search and by kind", async () => {
    fixture.api.mockResolvedValueOnce(listed());
    await render();
    expect(shown()).toEqual(["example.com", "Notion token", "Stripe secret key"]);
    expect(host.querySelector('[data-secret-row="Stripe secret key"]')!.textContent).toContain("Saved from a chat · Pepper · Not used yet");
    const linked = host.querySelector('[data-secret-row="Notion token"]')!;
    expect(linked.textContent).toContain("From 1Password · All bots");
    expect(linked.querySelectorAll("button")).toHaveLength(0);
    expect(host.querySelector("[data-logins-list]")!.querySelectorAll("input")).toHaveLength(0);
    await fill("[data-vault-search]", "notion");
    expect(shown()).toEqual(["Notion token"]);
    await fill("[data-vault-search]", "nothing like it");
    expect(host.querySelector("[data-vault-none]")!.textContent).toBe("Nothing matches your search.");
    await fill("[data-vault-search]", "");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-vault-filter="logins"]')!.click());
    expect(shown()).toEqual(["example.com"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-vault-filter="secrets"]')!.click());
    expect(shown()).toEqual(["Notion token", "Stripe secret key"]);
  });

  it("adds a secret for the bots chosen, and keeps nothing it was typed once saved", async () => {
    fixture.api.mockResolvedValueOnce(listed([])).mockResolvedValueOnce({ secret: SAVED }).mockResolvedValueOnce(listed());
    await render();
    await click("Add");
    await click("Add a secret");
    await fill('input[name="secretName"]', " Stripe secret key ");
    await fill('input[name="secretValue"]', "sk_test_fake-typed-secret");
    expect(host.querySelector<HTMLInputElement>('input[name="secretValue"]')!.type).toBe("password");
    await send("secret-form");
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/vault/secrets", { method: "POST", body: JSON.stringify({ name: "Stripe secret key", value: "sk_test_fake-typed-secret", bots: "all" }) });
    expect(host.querySelector("[data-secret-form]")).toBeNull();
    expect(host.innerHTML).not.toContain("sk_test_fake-typed-secret");
  });

  it("renames a secret and changes who may use it without touching its value, and deletes it on a second click", async () => {
    fixture.api.mockResolvedValueOnce(listed()).mockResolvedValueOnce({ secret: SAVED }).mockResolvedValueOnce(listed())
      .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(listed([LINKED]));
    await render();
    await click("Change Stripe secret key");
    expect(host.querySelector<HTMLInputElement>('input[name="secretValue"]')!.value).toBe("");
    await fill('input[name="secretName"]', "Stripe live key");
    await act(async () => { host.querySelector<HTMLInputElement>('[data-secret-form] input[type="radio"]')!.click(); });
    await send("secret-form");
    expect(fixture.api).toHaveBeenNthCalledWith(2, "/api/vault/secrets/s1", { method: "PATCH", body: JSON.stringify({ name: "Stripe live key", bots: "all" }) });
    await click("Delete Stripe secret key");
    expect(fixture.api).toHaveBeenCalledTimes(3);
    await click("Delete for good");
    expect(fixture.api).toHaveBeenNthCalledWith(4, "/api/vault/secrets/s1", { method: "DELETE" });
  });

  it("says which MCP servers lost their key when a secret is deleted", async () => {
    fixture.api.mockResolvedValueOnce(listed()).mockResolvedValueOnce({ ok: true, keysOff: ["stripe", "notion"] }).mockResolvedValueOnce(listed([LINKED]));
    await render();
    await click("Delete Stripe secret key");
    await click("Delete for good");
    expect(host.querySelector("[data-vault-keys-off]")?.textContent).toContain("stripe, notion");
  });

  it("imports a pasted .env file as one secret per line", async () => {
    fixture.api.mockImplementation(async (path: string) => (path === "/api/vault" ? listed([]) : { secret: SAVED }));
    await render();
    await click("Add");
    await click("Paste a .env file");
    await fill('textarea[name="envText"]', "# keys\nexport STRIPE_SECRET_KEY=sk_test_fake-one\nNOTION_TOKEN=\"fake two\"\n");
    await send("env-form");
    const posts = fixture.api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(posts).toEqual([{ name: "STRIPE_SECRET_KEY", value: "sk_test_fake-one", bots: "all" }, { name: "NOTION_TOKEN", value: "fake two", bots: "all" }]);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[name="envText"]')!.value).toBe("");
    expect(host.querySelector("[data-env-form] [role=status]")!.textContent).toBe("Saved to the Vault: 2.");
  });

  it("sends keys the app uses itself to API keys", async () => {
    fixture.api.mockResolvedValueOnce(listed([]));
    await render();
    expect(host.querySelector("[data-vault-keys]")!.textContent).toContain("AI and app keys");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-vault-keys] button")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "connections" });
  });
});

describe("Settings → Vault with My Cloud", () => {
  afterEach(() => { delete (window as { ogb?: unknown }).ogb; });
  const where = (site: string) => host.querySelector(`[data-login-row="${site}"] [data-login-where]`)?.textContent;

  it("without My Cloud says nothing of sides; on My Cloud itself says its logins are its own and sends nothing", async () => {
    (window as { ogb?: unknown }).ogb = { cloudLogins: { state: vi.fn().mockResolvedValue({ cloud: null }), send: vi.fn() } };
    fixture.api.mockResolvedValueOnce({ logins: [SHARED_LOGIN], onePassword: OFF });
    await render();
    expect(host.querySelector("[data-logins-sides]")).toBeNull();
    expect(host.querySelector("[data-also-cloud]")).toBeNull();
    expect(where("example.org")).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    delete (window as { ogb?: unknown }).ogb;
    fixture.config = { cloudHome: true };
    fixture.api.mockResolvedValueOnce({ logins: [SHARED_LOGIN], onePassword: OFF });
    await render();
    expect(host.querySelector("[data-logins-cloud-own]")!.textContent).toContain("come here by themselves");
    expect(host.querySelector("[data-also-cloud]")).toBeNull();
  });
});
