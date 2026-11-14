import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

const dispatch = vi.fn();
const fixture = vi.hoisted(() => ({ counting: false, values: [] as unknown[], index: 0, api: vi.fn(), track: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      if (!(index in fixture.values)) fixture.values[index] = initial;
      return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
    },
  };
});
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ dispatch }),
}));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));

import { SecretRequestCard } from "./SecretRequestCard";
import { VaultChoices } from "./VaultChoices";
import { setLocale } from "@/lib/i18n";
import { CREDENTIAL_TARGETS } from "../../shared/credential-request";

afterEach(() => setLocale("en"));

const secretCard = (secret: Record<string, unknown>): Message => ({
  id: "secret-card",
  role: "bot",
  kind: "secret",
  at: 1,
  text: "Securely provide the OpenAI API key.",
  secret: {
    target: "openaiImageApiKey",
    label: "OpenAI API key",
    description: "Generate a key at platform.openai.com. Scout can use it but never read it back.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
    requestKey: "request-key-1",
    ...secret,
  },
});

const view = (secret: Record<string, unknown>) => renderToStaticMarkup(createElement(SecretRequestCard, {
  botId: "bot-1",
  threadId: "thread-1",
  message: secretCard(secret),
}));

function namedCard(target: "greenferenceApiKey" | "geminiTtsKey", reason: string): Message {
  return secretCard({
    target,
    ...CREDENTIAL_TARGETS[target],
    description: `${CREDENTIAL_TARGETS[target].description} ${reason} Scout can use it but never read it back.`,
    descriptionParts: {
      baseCode: target === "greenferenceApiKey" ? "secretCard.greenference.description" : "secretCard.geminiTts.description",
      reason,
      bot: "Scout",
    },
  });
}

const escapedText = (text: string) => renderToStaticMarkup(createElement("span", null, text)).slice(6, -7);

beforeEach(() => {
  vi.stubGlobal("window", {});
  dispatch.mockReset();
});

describe("SecretRequestCard superseded requests", () => {
  it("still offers entry while the newest request is pending", () => {
    const html = view({});
    expect(html).toContain("Save securely");
    expect(html).toContain("never added to chat.");
  });

  it("stops offering entry and names its replacement once superseded", () => {
    const html = view({ superseded: true });
    expect(html).toContain("Superseded");
    expect(html).toContain("replaced by a newer one for the same key");
    expect(html).toContain("Superseded by a newer request");
    expect(html).not.toContain("Save securely");
    expect(html).not.toContain("type=\"password\"");
    expect(html).not.toContain("Not now");
    expect(html).not.toContain("Waiting to resume safely");
  });
});

describe("SecretRequestCard on a page reached through a desktop paired to another computer", () => {
  const remote = (secret: Record<string, unknown>) => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    return view(secret);
  };

  it("offers the field for a secret the server keeps: a custom one, or a provider key", () => {
    for (const secret of [
      { target: "customSecret", label: "Mailbox password", delivery: "ref", placeholder: "", helpUrl: "" },
      { target: "openaiApiKey", label: "OpenAI API key" },
    ]) {
      const html = remote(secret);
      expect(html, secret.target).toContain('type="password"');
      expect(html, secret.target).not.toContain("must be saved on the host computer");
    }
  });

  it("sends a key the host computer keeps in its own encrypted store to that computer", () => {
    const html = remote({ target: "boxToken", label: "Boat token" });
    expect(html).toContain("must be saved on the host computer");
    expect(html).not.toContain('type="password"');
  });
});

describe("SecretRequestCard ask card", () => {
  it("waits as a compact ask card with a masked field", () => {
    const html = view({});
    expect(html).toContain('data-ask-card="pending"');
    expect(html).toContain("text-accent-text");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
  });

  it("stays in view while it waits, however far the chat scrolls, and lets go once it is settled", () => {
    expect(view({})).toMatch(/data-ask-card="pending"[^>]*class="[^"]*\bsticky\b/);
    expect(view({ provided: true, resumed: true })).not.toContain("sticky");
    expect(view({ superseded: true })).not.toContain("sticky");
  });

  it("folds into one line that names the key once it is saved and the bot resumed", () => {
    const html = view({ provided: true, resumed: true });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain("OpenAI API key saved securely");
    expect(html).toContain("Bot resumed without seeing the key");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
  });

  it("keeps a retry on the line when resuming after the save failed", () => {
    const html = view({ provided: true, error: "The bot could not be resumed." });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain("Try again");
    expect(html).toContain("The bot could not be resumed.");
    expect(html).not.toContain('type="password"');
  });
});

describe("SecretRequestCard Greenference copy", () => {
  it("localizes the Greenference title, description and password field without changing the saved card", () => {
    const message = namedCard("greenferenceApiKey", "Para preparar o resumo solicitado.");
    const render = () => renderToStaticMarkup(createElement(SecretRequestCard, { botId: "bot-1", threadId: "thread-1", message }));
    const english = render();
    expect(english).toContain('aria-label="Greenference API key"');
    expect(english).toContain("Runs Greenference models with your own key.");
    expect(english).toContain('placeholder="Paste your Greenference API key"');
    expect(english).toContain(escapedText(message.secret!.description));
    setLocale("pt-br");
    const portuguese = render();
    expect(portuguese).toContain('aria-label="Chave de API do Greenference"');
    expect(portuguese).toContain("Roda modelos do Greenference com sua própria chave. Para preparar o resumo solicitado. Scout pode usar o valor, mas nunca consegue lê-lo.");
    expect(portuguese).toContain('placeholder="Cole sua chave de API do Greenference"');
    expect(portuguese).toContain(CREDENTIAL_TARGETS.greenferenceApiKey.helpUrl);
    expect(message.secret).toMatchObject({ target: "greenferenceApiKey", description: `${CREDENTIAL_TARGETS.greenferenceApiKey.description} Para preparar o resumo solicitado. Scout can use it but never read it back.` });
    setLocale("en");
    expect(render()).toBe(english);
  });

  it.each([
    { stopped: true },
    { superseded: true },
    { provided: true, resumed: true },
  ])("localizes the Greenference label in settled states %j", (state) => {
    setLocale("pt-br");
    const html = view({ target: "greenferenceApiKey", ...CREDENTIAL_TARGETS.greenferenceApiKey, ...state });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain('aria-label="Chave de API do Greenference"');
    expect(html).not.toContain('aria-label="Greenference API key"');
    expect(html).not.toContain("<input");
  });
});

describe("SecretRequestCard Gemini copy", () => {
  it("localizes the Gemini title, description and password field without changing the saved card", () => {
    const message = namedCard("geminiTtsKey", "Para preparar o resumo solicitado.");
    const render = () => renderToStaticMarkup(createElement(SecretRequestCard, { botId: "bot-1", threadId: "thread-1", message }));
    const english = render();
    expect(english).toContain('aria-label="Gemini speech API key"');
    expect(english).toContain(CREDENTIAL_TARGETS.geminiTtsKey.description);
    expect(english).toContain('placeholder="Paste your Google AI Studio API key"');
    expect(english).toContain(escapedText(message.secret!.description));
    setLocale("pt-br");
    const portuguese = render();
    expect(portuguese).toContain('aria-label="Chave de API de voz do Gemini"');
    expect(portuguese).toContain("Gera respostas faladas, mensagens de voz e a fala das chamadas com o Gemini. Para preparar o resumo solicitado. Scout pode usar o valor, mas nunca consegue lê-lo.");
    expect(portuguese).toContain('placeholder="Cole sua chave de API do Google AI Studio"');
    expect(portuguese).toContain(CREDENTIAL_TARGETS.geminiTtsKey.helpUrl);
    expect(message.secret).toMatchObject({ target: "geminiTtsKey", description: `${CREDENTIAL_TARGETS.geminiTtsKey.description} Para preparar o resumo solicitado. Scout can use it but never read it back.` });
    setLocale("en");
    expect(render()).toBe(english);
  });

  it.each([
    { stopped: true },
    { superseded: true },
    { provided: true, resumed: true },
  ])("localizes the Gemini label in settled states %j", (state) => {
    setLocale("pt-br");
    const html = view({ target: "geminiTtsKey", ...CREDENTIAL_TARGETS.geminiTtsKey, ...state });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain('aria-label="Chave de API de voz do Gemini"');
    expect(html).not.toContain('aria-label="Gemini speech API key"');
    expect(html).not.toContain("<input");
  });
});

describe("SecretRequestCard mailbox", () => {
  const email = { target: "customSecret", delivery: "email", label: "Connect your mailbox", placeholder: "Mailbox password", helpUrl: "", description: "Ledger never sees the password." };

  it("asks for the address and the password on one card, with the address the bot knew", () => {
    const html = view({ ...email, address: "me@shop.example" });
    expect(html).toContain('type="email"');
    expect(html).toContain('value="me@shop.example"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Mailbox password");
    expect(html).toContain("They never see it.");
  });

  it("asks for the server only once one could not be found, and other cards have no address field", () => {
    expect(view(email)).not.toContain("Incoming mail server");
    expect(view({})).not.toContain('type="email"');
  });

  it("connects with Connect, and while it checks shows the incoming server that took the password", () => {
    expect(view({ ...email, address: "me@shop.example" })).toContain(">Connect<");
    const html = view({ ...email, address: "me@shop.example", emailReading: "imap.shop.example" });
    expect(html).toMatch(/data-email-check="done".*imap\.shop\.example/su);
    expect(html).toContain('data-email-check="waiting"');
  });

  it("for a mailbox that reads but can't send, asks only for its outgoing server, filled with what is known", () => {
    const html = view({ ...email, label: "Outgoing server for me@shop.example", placeholder: "Password for sending", address: "me@shop.example", emailOutgoing: { smtpHost: "smtp.shop.example", smtpPort: 587 } });
    expect(html).toContain("data-email-outgoing-request");
    expect(html).toContain("Outgoing server for me@shop.example");
    expect(html).toContain('value="smtp.shop.example"');
    expect(html).toContain('value="587"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Save securely");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain(">Connect<");
  });

  it("says the bot goes on once connected, without the address field", () => {
    const html = view({ ...email, provided: true, resumed: true, address: "me@shop.example" });
    expect(html).toContain('data-ask-card="settled"');
    expect(html).not.toContain("<input");
  });
});

describe("SecretRequestCard key analytics", () => {
  const KEY = "boat_ZZtestSECRET0123456789abcdef";
  type Props = { children?: ReactNode; type?: string; onChange?: (event: { target: { value: string } }) => void; onSubmit?: (event: { preventDefault(): void }) => void };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const card = (target: string, extra: Record<string, unknown> = {}) => {
    fixture.counting = true;
    fixture.index = 0;
    try {
      return nodes(SecretRequestCard({ botId: "bot-1", threadId: "thread-1", message: secretCard({ target, label: "Key", ...extra }) }));
    } finally {
      fixture.counting = false;
    }
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  async function submit(target: string, typed = KEY, extra: Record<string, unknown> = {}) {
    card(target, extra).find((node) => node.type === "input")!.props.onChange!({ target: { value: typed } });
    card(target, extra).find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: () => {} });
    await flush();
  }

  beforeEach(() => {
    fixture.values = [];
    fixture.api.mockReset();
    fixture.track.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a Boat key saved over the desktop bridge once, even when only the resume is retried", async () => {
    const setCredential = vi.fn().mockResolvedValue({ box: { configured: true } });
    vi.stubGlobal("window", { ogb: { setCredential } });
    fixture.api.mockRejectedValueOnce(new Error("resume failed")).mockResolvedValueOnce({ ok: true });
    await submit("boxToken");
    card("boxToken").find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: () => {} });
    await flush();
    expect(setCredential).toHaveBeenCalledExactlyOnceWith("boxToken", KEY);
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "boat", via: "chat_request", result: "ok" }]]);
    for (const fragment of [KEY, KEY.slice(0, 6), KEY.slice(-6), String(KEY.length)]) expect(JSON.stringify(fixture.track.mock.calls)).not.toContain(fragment);
  });

  it("reports a Boat key boat.dev refused as rejected", async () => {
    vi.stubGlobal("window", { ogb: { setCredential: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'credential:set': KeyRejected: That doesn't look like a Boat API key")) } });
    await submit("boxToken");
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "boat", via: "chat_request", result: "rejected" }]]);
  });

  // Even with the desktop bridge, the 1Password token goes to this server's Logins (which checks it with 1Password),
  // never the bridge's settings-file store: on My Cloud no bridge exists, and the Cloud's Logins is where bots read it.
  it("saves a 1Password token through Logins, never the settings bridge, then resumes the bot", async () => {
    const setCredential = vi.fn();
    vi.stubGlobal("window", { ogb: { setCredential } });
    fixture.api.mockResolvedValueOnce({ onePassword: { connected: true } }).mockResolvedValueOnce({ ok: true });
    await submit("onePasswordToken", "ops_ZZtestSECRET0123456789");
    expect(setCredential).not.toHaveBeenCalled();
    expect(fixture.api.mock.calls[0]).toEqual(["/api/logins/1password", { method: "POST", body: JSON.stringify({ token: "ops_ZZtestSECRET0123456789" }) }]);
    expect(fixture.api.mock.calls[1]![0]).toBe("/api/bots/bot-1/secret-cards/secret-card/provided");
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.track.mock.calls)).not.toContain("ZZtestSECRET");
  });

  it("reports an xAI key saved from chat as unverified: nothing checks it before it is used", async () => {
    fixture.api.mockResolvedValueOnce({ xai: { configured: true } }).mockResolvedValueOnce({ ok: true });
    await submit("xaiApiKey", "xai-ZZtestSECRET0123456789");
    expect(fixture.api.mock.calls[0]).toEqual(["/api/config", { method: "PUT", body: JSON.stringify({ xai: { key: "xai-ZZtestSECRET0123456789" } }) }]);
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "xai", via: "chat_request", result: "unverified" }]]);
  });

  it("saves an Anthropic key in the desktop store as Settings does, keeping Claude sign-ins", async () => {
    const setCredential = vi.fn().mockResolvedValue({ anthropic: { configured: true } });
    vi.stubGlobal("window", { ogb: { setCredential } });
    fixture.api.mockResolvedValueOnce({ ok: true });
    await submit("anthropicApiKey", "sk-ant-ZZtestSECRET0123456789");
    expect(setCredential).toHaveBeenCalledExactlyOnceWith("anthropicApiKey", "sk-ant-ZZtestSECRET0123456789", { everyClaudeBot: false });
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(["/api/bots/bot-1/secret-cards/secret-card/provided"]);
    expect(fixture.track.mock.calls).toEqual([["api_key_saved", { provider: "anthropic", via: "chat_request", result: "unverified" }]]);
  });

  it("sends a provider key typed on a desktop paired to another computer to that computer's server", async () => {
    const setCredential = vi.fn();
    vi.stubGlobal("window", { ogb: { setCredential, remoteClient: { active: true } } });
    fixture.api.mockResolvedValueOnce({ anthropic: { configured: true } }).mockResolvedValueOnce({ ok: true });
    await submit("anthropicApiKey", "sk-ant-ZZtestSECRET0123456789");
    expect(setCredential).not.toHaveBeenCalled();
    expect(fixture.api.mock.calls[0]).toEqual(["/api/config", { method: "PUT", body: JSON.stringify({ anthropic: { key: "sk-ant-ZZtestSECRET0123456789", everyClaudeBot: false } }) }]);
  });

  it("saves the Composio key in the desktop store's slot, as Settings does", async () => {
    const setCredential = vi.fn().mockResolvedValue({ composio: { configured: true } });
    vi.stubGlobal("window", { ogb: { setCredential } });
    fixture.api.mockResolvedValueOnce({ ok: true });
    await submit("composioApiKey", "ak_ZZtestSECRET0123456789");
    expect(setCredential).toHaveBeenCalledExactlyOnceWith("composioApiKey", "ak_ZZtestSECRET0123456789");
  });

  // A custom secret goes only to its own card's save, which resumes the bot: never Settings, the desktop store or an event.
  it("keeps a custom secret behind its card, with no product event naming it", async () => {
    const setCredential = vi.fn();
    vi.stubGlobal("window", { ogb: { setCredential } });
    fixture.api.mockResolvedValueOnce({ provided: true, resumed: true });
    await submit("customSecret", "sk_live_ZZtestSECRET0123456789", { delivery: "ref", helpUrl: "" });
    expect(setCredential).not.toHaveBeenCalled();
    expect(fixture.api.mock.calls).toEqual([["/api/bots/bot-1/secret-cards/secret-card/save", {
      method: "POST", body: JSON.stringify({ threadId: "thread-1", value: "sk_live_ZZtestSECRET0123456789" }),
    }]]);
    expect(fixture.track).not.toHaveBeenCalled();
  });
});

describe("SecretRequestCard custom secrets", () => {
  it.each(["file", "ref"] as const)("localizes the stopped %s delivery using its recorded author, not the saved description's words", (delivery) => {
    const message: Message = { ...secretCard({ target: "customSecret", reason: "To create test charges.", description: "Original saved description.", helpUrl: "", delivery, stopped: true }), from: { botId: "bot-1", name: "Scout", color: "green" } };
    const render = () => renderToStaticMarkup(createElement(SecretRequestCard, { botId: "bot-1", threadId: "thread-1", message }));
    expect(render()).toContain('title="Original saved description."');
    setLocale("pt-br");
    const html = render();
    expect(html).toContain("To create test charges.");
    expect(html).toContain(delivery === "file" ? "Os comandos de Scout podem ler" : "Scout recebe uma referência de uso único");
    expect(html).not.toContain("Original saved description.");
    setLocale("en");
    expect(render()).toContain('title="Original saved description."');
  });

  it.each(["file", "ref"] as const)("uses the direct chat's bot name for stopped %s delivery without a group author", (delivery) => {
    const message = secretCard({ target: "customSecret", stopped: true, description: "Saved direct chat description.", delivery });
    const render = () => renderToStaticMarkup(createElement(SecretRequestCard, { botId: "bot-1", botName: "Scout", threadId: "thread-1", message }));
    expect(render()).toContain('title="Saved direct chat description."');
    setLocale("pt-br");
    expect(render()).toContain(delivery === "file" ? "Os comandos de Scout podem ler" : "Scout recebe uma referência de uso único");
    expect(render()).not.toContain("Saved direct chat description.");
  });

  it("keeps an older card's description when no recorded author is available", () => {
    setLocale("pt-br");
    expect(view({ target: "customSecret", stopped: true, description: "Saved legacy description", delivery: "file" })).toContain('title="Saved legacy description"');
  });

  it("says what the bot may do with it, in the bot's words and plainly, with no key link", () => {
    const file = view({ target: "customSecret", label: "Stripe secret key", reason: "To create test charges.", description: "To create test charges. Scout's commands can read it.", helpUrl: "", delivery: "file" });
    expect(file).toContain("To create test charges.");
    expect(file).not.toContain("Scout&#x27;s commands can read it.");
    expect(file).toContain("Saved to a private file your bot&#x27;s commands can read for 24 hours, then deleted.");
    expect(file).not.toContain("Where to get this key");
    const ref = view({ target: "customSecret", label: "Notion key", reason: "For Notion.", helpUrl: "", delivery: "ref" });
    expect(ref).toContain("MausBot keeps it for one use by its own tools. Your bot never sees it");
  });
});

describe("SecretRequestCard saved secrets", () => {
  type Props = { children?: ReactNode };
  const nodes = (tree: ReactNode): Array<ReactElement<Props>> =>
    Children.toArray(tree).flatMap((child) => isValidElement<Props>(child) ? [child, ...nodes(child.props.children)] : []);
  const offered = (secret: Record<string, unknown>) => {
    Object.assign(fixture, { counting: true, index: 0, values: [] });
    try { return nodes(SecretRequestCard({ botId: "bot-1", threadId: "thread-1", message: secretCard(secret) })).some((node) => node.type === VaultChoices); }
    finally { fixture.counting = false; }
  };

  it("offers the Vault's secrets on a card for any other secret, never for a key the app keeps or a mailbox", () => {
    expect(offered({ target: "customSecret", label: "Stripe secret key", delivery: "ref", helpUrl: "" })).toBe(true);
    expect(offered({})).toBe(false);
    expect(offered({ target: "customSecret", label: "Connect your mailbox", delivery: "email", helpUrl: "" })).toBe(false);
  });
});
