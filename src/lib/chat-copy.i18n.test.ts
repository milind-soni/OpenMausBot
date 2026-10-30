// Pure helpers that hold English in module-scope tables can resolve a label once at import and never follow the language.
import { afterEach, describe, expect, it } from "vitest";

import { activeLocale, setLocale } from "./i18n";
import { liveActivityLabel } from "./live-activity";
import { replyAuthor, replySnippet } from "./replies";
import { costCaption, usageChip, usageDetail } from "./usage";
import type { Message } from "@/state/store";

const activity = (name: string, extra: Record<string, unknown> = {}): Message =>
  ({ id: "a", at: 1, role: "bot", kind: "activity", tool: { ...extra, name } }) as Message;

afterEach(() => {
  setLocale("en");
});

describe("live activity label", () => {
  it("translates the fallback table, which is built once at import time", () => {
    setLocale("pt-br");
    expect(liveActivityLabel()).toBe("Pensando");
    expect(liveActivityLabel(activity("Bash: pnpm test"))).toBe("Executando um comando");
    expect(liveActivityLabel(activity("mcp__computer__click"))).toBe("Usando a tela");

    setLocale("ja");
    expect(liveActivityLabel(activity("web_search"))).toBe("ウェブを検索中");
    expect(liveActivityLabel(activity("something_unknown"))).toBe("作業中");
  });

  it("leaves the server's own narration alone", () => {
    setLocale("pt-br");
    expect(liveActivityLabel(activity("Edit", { spoken: "editando um arquivo" }))).toBe(
      "Editando um arquivo",
    );
  });
});

describe("the memo key the transcript uses", () => {
  it("reports the locale that took effect, after fallback", () => {
    // MessagesList is memoized on its props; this is the only one that changes with the language.
    expect(setLocale("pt-BR")).toBe("pt-br");
    expect(activeLocale()).toBe("pt-br");
    setLocale("de-AT");
    expect(activeLocale()).toBe("de");
    setLocale("xx-YY");
    expect(activeLocale()).toBe("en");
  });
});

describe("usage chip", () => {
  const usage = { input: 2000, output: 500, costUsd: 0.02, turns: 2 };

  it("translates the units and the cost caption", () => {
    setLocale("pt-br");
    expect(usageDetail(usage)).toContain("entrada");
    expect(usageDetail(usage)).toContain("saída");
    expect(usageChip(usage)).toBe("$0.02");
    expect(usageChip({ ...usage, costUsd: null })).toContain("entrada");
    expect(costCaption("subscription")).toBe("equivalente — está na sua assinatura, não é cobrado");
    expect(costCaption(undefined)).toBe("conforme informado pelo provedor");
  });
});

describe("reply quote", () => {
  it("names the author and the stripped attachments in the reader's language", () => {
    setLocale("pt-br");
    const fromUser = { id: "m", at: 1, role: "user", kind: "text" } as Message;
    expect(replyAuthor(fromUser)).toBe("Você");
    expect(replyAuthor({ ...fromUser, role: "bot" } as Message)).toBe("Assistente");
    expect(replySnippet('<attached-image path="/tmp/a.png" />')).toBe("[imagem]");
  });
});
