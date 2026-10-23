import { afterEach, describe, expect, it, vi } from "vitest";

import { overviewLineText, overviewRoutineText, recentChangeText } from "./bot-overview-text";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

describe("an overview routine line", () => {
  const at = new Date(2026, 9, 22, 18, 20).getTime();

  it("is worded from its data in the reader's language, with two-digit 24-hour times", () => {
    setLocale("pt-br");
    expect(overviewRoutineText({ name: "Paused Sunday", paused: true, schedule: { type: "interval", everyMinutes: 60 } as never })).toBe("Pausada: Paused Sunday.");
    expect(overviewRoutineText({ name: "Triage", schedule: { type: "interval", everyMinutes: 60 } as never, nextRunAt: at, lastRun: { status: "completed", at } }))
      .toBe("A cada hora: Triage. Próxima execução às 18:20. Última execução concluída às 18:20.");
    expect(overviewRoutineText({ name: "Odd", schedule: { type: "cron", expression: "*/20 9-17 * * 1-5", timeZone: "UTC" } as never })).toMatch(/^.+: Odd\.$/);
  });

  it("leaves English to the server, and a status this build does not know to the server's line", () => {
    expect(overviewRoutineText({ name: "Triage", schedule: { type: "interval", everyMinutes: 60 } as never })).toBeNull();
    setLocale("pt-br");
    expect(overviewRoutineText({ name: "Triage", schedule: { type: "interval", everyMinutes: 60 } as never, lastRun: { status: "paused-forever", at } })).toBeNull();
    expect(overviewRoutineText(undefined)).toBeNull();
  });
});

describe("the server's other overview lines", () => {
  const lines = [
    "Can use 2 connected apps: gmail, googlecalendar.",
    "Can use 1 connected app: gmail.",
    "Coordinates its section as Chief of Staff.",
    "May also coordinate these teams: General, Research.",
    "Connected apps could not be checked.",
    "Works in /Users/me/project.",
    "Command approvals follow the provider's custom configuration.",
    "Asks before contacting other bots.",
    "Can't use a computer.",
    "Profile proposal cards require your approval.",
    "Knows how to triage incoming bug reports.",
    "Listens for “Orders” webhooks.",
  ];

  it("read exactly as the server wrote them in English", () => {
    for (const line of lines) expect(overviewLineText(line)).toBe(line);
    expect(recentChangeText("soul: 120 → 340 bytes")).toBe("soul: 120 → 340 bytes");
  });

  it("are worded in pt-BR, the app names, folders, quotes and team names kept as data", () => {
    setLocale("pt-br");
    expect(lines.map((line) => overviewLineText(line))).toEqual([
      "Pode usar 2 apps conectados: gmail, googlecalendar.",
      "Pode usar 1 app conectado: gmail.",
      "Coordena a seção como Chefe de gabinete.",
      "Também pode coordenar estas equipes: General, Research.",
      "Não foi possível verificar os apps conectados.",
      "Trabalha em /Users/me/project.",
      "As aprovações de comandos seguem a configuração personalizada do provedor.",
      "Pergunta antes de entrar em contato com outros bots.",
      "Não pode usar um computador.",
      "Os cartões de proposta de perfil precisam da sua aprovação.",
      "Habilidade: triage incoming bug reports.",
      "Recebe webhooks “Orders”.",
    ]);
    expect(overviewLineText("Computer preference: Local VM, which isn't available on My Cloud.")).toBe("Trabalha em: desktop privado, que não está disponível no Cloud.");
    expect(recentChangeText("soul: 120 → 340 bytes")).toBe("instruções permanentes: 120 → 340 bytes");
    expect(recentChangeText("mystery: a → b")).toBe("mystery: a → b");
    expect(overviewLineText("A line from a newer server.")).toBe("A line from a newer server.");
  });
});

describe("team names in the overview", () => {
  it("stay as data, and only the unnamed section the server marks is labelled", () => {
    setLocale("pt-br");
    expect(overviewLineText("May also coordinate these teams: General.", ["General"])).toBe("Também pode coordenar estas equipes: General.");
    expect(overviewLineText("May also coordinate these teams: Research, General.", ["Research, General"])).toBe("Também pode coordenar estas equipes: Research, General.");
    expect(overviewLineText("May also coordinate these teams: General, Research.", ["", "Research"])).toBe("Também pode coordenar estas equipes: Geral, Research.");
    expect(overviewLineText("May also coordinate these teams: General, Research.")).toBe("Também pode coordenar estas equipes: General, Research.");
  });
});

describe("a computer that is not on My Cloud, in English", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["en-US", "en-GB", "en-AU", "en-IN"])("reads as it did before (%s)", (region) => {
    vi.stubGlobal("navigator", { language: region });
    setLocale("en");
    expect(overviewLineText("Computer preference: Local VM, which isn't available on My Cloud.")).toBe("Works on: Local VM, which isn't available on My Cloud.");
    expect(overviewLineText("Computer preference: this computer, which isn't available on My Cloud.")).toBe("Works on: this computer, which isn't available on My Cloud.");
  });
});
