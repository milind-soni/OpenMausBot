// The superseded state is the credential card's equivalent of an expired
// proposal: the request that created it is dead, so the card must stop
// offering entry (form, dismiss, retry) and say what replaced it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

const dispatch = vi.fn();
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch }),
}));

import { SecretRequestCard } from "./SecretRequestCard";

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

describe("SecretRequestCard ask card", () => {
  it("waits as a compact ask card with a masked field", () => {
    const html = view({});
    expect(html).toContain('data-ask-card="pending"');
    expect(html).toContain("text-accent-text");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
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
