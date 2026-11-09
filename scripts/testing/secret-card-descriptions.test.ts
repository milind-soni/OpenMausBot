import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CREDENTIAL_TARGETS, type CredentialTargetId } from "../../shared/credential-request.ts";
import { DATA_DIR, loadConfig } from "../../server/config.ts";
import { createSecretCards } from "../../server/host/secret-cards.ts";
import { PhoneSecretSubmissionRegistry } from "../../server/phone-secret.ts";
import { Store } from "../../server/store.ts";
import { VaultStore } from "../../server/vault-store.ts";
import "../../server/server-line-packs.ts";
import { SecretRequestCard } from "../../src/components/SecretRequestCard";
import { setLocale } from "../../src/lib/i18n";
import type { Message } from "../../src/state/store";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ dispatch: vi.fn() }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

beforeEach(() => vi.stubGlobal("window", {}));
afterEach(() => {
  setLocale("en");
  vi.unstubAllGlobals();
});

function producedCard(target: CredentialTargetId, reason: string, language?: string): Message {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
  const bot = store.createBot({ name: "Scout" });
  const cards = createSecretCards({
    store,
    cfg: loadConfig(),
    botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
    vaultStore: new VaultStore({ dataDir: DATA_DIR }),
    phoneSecrets: { provide: vi.fn(), open: vi.fn() },
    phoneSecretSubmissions: new PhoneSecretSubmissionRegistry(),
    connectorThread: () => ({ bot, group: undefined }),
    answerCardNode: () => false,
    dataDir: DATA_DIR,
    providerKeysRefused: false,
    layerFolder: () => DATA_DIR,
    turnVm: () => undefined,
    threadLanguage: () => language,
  });
  const response = cards.requestCredential(bot, bot.threadId, { credentialId: target, reason });
  expect(response.status).toBe(201);
  return store.messagesFor(bot.threadId).find((message) => message.id === response.body.messageId)! as Message;
}

const render = (message: Message) => renderToStaticMarkup(createElement(SecretRequestCard, { botId: "bot-1", threadId: "thread-1", message }));
const escapedText = (text: string) => renderToStaticMarkup(createElement("span", null, text)).slice(6, -7);

const localizedTargets = [
  ["greenferenceApiKey", "Roda modelos do Greenference com sua própria chave."],
  ["geminiTtsKey", "Gera respostas faladas, mensagens de voz e a fala das chamadas com o Gemini."],
] as const;

describe("credential descriptions from the real producer to the renderer", () => {
  it.each(Object.keys(CREDENTIAL_TARGETS) as CredentialTargetId[])("preserves the complete English description for %s", (target) => {
    const reason = "For today's report <draft>.";
    const message = producedCard(target, reason);
    const description = `${CREDENTIAL_TARGETS[target].description} ${reason} Scout can use it but never read it back.`;
    expect(message.secret!.description).toBe(description);
    const english = render(message);
    expect(english).toContain(escapedText(description));
    const legacy = { ...message, secret: { ...message.secret!, descriptionParts: undefined } };
    expect(english).toBe(render(legacy));
    if (!message.secret!.descriptionParts) {
      setLocale("pt-br");
      expect(render(message)).toContain(escapedText(description));
    }
  });

  it.each(localizedTargets)("keeps the reason and guarantee when localizing %s", (target, base) => {
    const reason = "For today's report <draft>.";
    const message = producedCard(target, reason);
    const saved = JSON.stringify(message);
    const english = render(message);
    setLocale("pt-br");
    expect(render(message)).toContain(escapedText(`${base} ${reason} Scout pode usar o valor, mas nunca consegue lê-lo.`));
    expect(JSON.stringify(message)).toBe(saved);
    setLocale("en");
    expect(render(message)).toBe(english);
  });

  it.each(localizedTargets)("uses the received English fallback verbatim for %s", (target) => {
    const message = producedCard(target, "For the requested report.", "pt-br");
    message.secret!.description += " Additional server context.";
    message.secret!.label += " supplied label";
    message.secret!.placeholder += " supplied placeholder";
    const html = render(message);
    expect(html).toContain(escapedText(message.secret!.description));
    expect(html).toContain(`aria-label="${message.secret!.label}"`);
    expect(html).toContain(`placeholder="${message.secret!.placeholder}"`);
  });

  it.each([
    ["greenferenceApiKey", "en"],
    ["greenferenceApiKey", "pt-br"],
    ["geminiTtsKey", "en"],
    ["geminiTtsKey", "pt-br"],
  ] as const)("keeps the raw description of an older %s card in %s", (target, locale) => {
    const message = producedCard(target, "For the requested report.");
    delete message.secret!.descriptionParts;
    setLocale(locale);
    expect(render(message)).toContain(escapedText(message.secret!.description));
  });

  it.each(localizedTargets)("keeps the guarantee without an optional reason for %s", (target, base) => {
    const message = producedCard(target, "");
    setLocale("pt-br");
    expect(render(message)).toContain(escapedText(`${base} Scout pode usar o valor, mas nunca consegue lê-lo.`));
  });
});
