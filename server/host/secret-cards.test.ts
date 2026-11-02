import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import "../server-line-packs.ts";
import type { BotRecord, Message } from "../store.ts";
import { createSecretCards } from "./secret-cards.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(language?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-secret-cards-"));
  dirs.push(dataDir);
  const lines: Message[] = [];
  let ids = 0;
  const store = {
    activePath: () => lines,
    messagesFor: () => lines,
    appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++ids}`, at: Date.now(), ...message } as Message;
      lines.push(full);
      return full;
    },
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => {
      const message = lines.find(line => line.id === id);
      return message ? Object.assign(message, patch) : null;
    },
    botByThread: () => null,
    groupByThread: () => undefined,
    onChange: () => () => {},
  };
  const bot = { id: "ledger", name: "Ledger" } as BotRecord;
  const cards = createSecretCards({
    store: store as never, cfg: {} as never, botLogins: { credentialConfig: (config) => ({ ...config, onePassword: { connected: false } }) },
    phoneSecrets: { provide: async () => {}, open: () => {} } as never, phoneSecretSubmissions: {} as never,
    connectorThread: () => ({ bot, group: undefined }), answerCardNode: () => true, dataDir, providerKeysRefused: false,
    layerFolder: () => dataDir, turnVm: () => undefined, ...(language ? { threadLanguage: () => language } : {}),
  });
  return { cards, lines, bot };
}

describe("the card a bot asks for a key or secret with", () => {
  it("final credential display translates only a new built-in card and preserves history, reason and custom input", () => {
    const { cards, lines, bot } = fixture("zh-TW");
    lines.push({ id: "history", at: 1, role: "bot", kind: "secret", text: "Historical card text", secret: {
      target: "boxToken", label: "Boat API key", description: "Historical description", placeholder: "Historical placeholder",
      helpUrl: "https://docs.boat.dev/api-keys", requestKey: "historical-request",
    } } as Message);
    const reason = "Keep {reason} exactly as written.";
    const result = cards.requestCredential(bot, "ledger-main", { credentialId: "boxToken", reason });
    expect(result.status).toBe(201);
    expect(result.body.label).toBe("Boat API key");
    expect(lines[1]!.secret).toMatchObject({ target: "boxToken", label: "Boat API 金鑰", placeholder: "貼上你的 Boat API 金鑰", helpUrl: "https://docs.boat.dev/api-keys" });
    expect(lines[1]!.secret!.description).toContain("選擇 Boat 時");
    expect(lines[1]!.secret!.description).toContain(reason);
    expect(lines[0]!.secret).toMatchObject({ label: "Boat API key", description: "Historical description", placeholder: "Historical placeholder", superseded: true });
    cards.requestCredential(bot, "ledger-main", { credentialId: "xaiApiKey" });
    expect(lines[2]!.secret!.placeholder).toBe("xai-…");
    cards.requestCredential(bot, "ledger-main", { label: "Original custom label", reason, placeholder: "Original custom hint", delivery: "ref" });
    expect(lines[3]!.secret).toMatchObject({ target: "customSecret", label: "Original custom label", reason, placeholder: "Original custom hint" });
  });

  it("asks in the language of the conversation's person", () => {
    const { cards, lines, bot } = fixture("de");
    expect(cards.requestCredential(bot, "ledger-main", { credentialId: "xaiApiKey" }).status).toBe(201);
    expect(cards.requestCredential(bot, "ledger-main", { label: "Stripe-Testschlüssel", reason: "Für Testzahlungen.", delivery: "file" }).status).toBe(201);
    expect(lines.map((line) => line.text)).toEqual([
      "Gib xAI API-Schlüssel sicher in OpenMausBot auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
      "Gib Stripe-Testschlüssel sicher in OpenMausBot auf deinem Telefon oder Computer ein. Es wird nie in den Chat übernommen.",
    ]);
    expect(lines[0]!.secret!.description).toBe("Für den integrierten Grok-Anbieter. Ledger kann es verwenden, aber nie auslesen.");
    expect(lines[1]!.secret!.description)
      .toBe("Für Testzahlungen. Die Befehle von Ledger können es 24 Stunden lang aus einer privaten Datei lesen; es wird nie in den Chat übernommen.");
  });

  it("asks in English where no language is known", () => {
    const { cards, lines, bot } = fixture();
    cards.requestCredential(bot, "ledger-main", { label: "Notion token", reason: "For Notion's MCP server.", delivery: "ref" });
    expect(lines[0]!.text).toBe("Securely provide the Notion token from OpenMausBot on your phone or computer. It is never added to chat.");
    expect(lines[0]!.secret!.description).toBe("For Notion's MCP server. Ledger gets a one-use reference for OpenMausBot's own tools and never sees it.");
  });
});
