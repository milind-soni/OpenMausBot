import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { StoreProvider, type Bot, type Message } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";
import {
  PendingApprovalActions,
  PendingApprovalPanel,
  spokenApprovalPrompt,
  type Pending,
} from "./PendingApproval";

function commandApproval(answered?: "allow" | "deny"): { message: Message; pending: Pending } {
  const message: Message = {
    id: "approval-card",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: "Approval needed",
      subtitle: "pnpm test",
      options: ["Allow", "Deny"],
      answered,
      requestId: "approval-request",
      tool: "Bash",
    },
  };
  return {
    message,
    pending: {
      message,
      requestId: "approval-request",
      tool: "Bash",
      allowKey: "Bash:pnpm test",
      detail: "pnpm test",
    },
  };
}

afterEach(() => {
  setLocale("en");
});

describe("German approval cards", () => {
  it("renders a pending command approval in German", () => {
    setLocale("de");
    const { message } = commandApproval();

    const markup = renderToStaticMarkup(createElement(ApprovalCard, {
      bot: { name: "Mochi" } as Bot,
      message,
    }));

    expect(markup).toContain("Mochi möchte einen Befehl ausführen");
    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain("Wartet unten auf deine Antwort");
  });

  it("renders a denied command approval in German", () => {
    setLocale("de");
    const { message } = commandApproval("deny");

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));

    expect(markup).toContain("Abgelehnt");
  });

  it("renders the pending approval strip in German", () => {
    setLocale("de");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, {
      pending,
      count: 3,
      index: 1,
    }));

    expect(markup).toContain('aria-label="Ausstehende Freigabe"');
    expect(markup).toContain("Ausstehende Freigabe");
    expect(markup).toContain("2 von 3");
    expect(markup).toContain("Befehlsfreigabe angefordert");
    expect(markup).toContain('aria-label="Details zur Freigabe prüfen"');
  });

  it("speaks a command approval in German", () => {
    setLocale("de");
    const { pending } = commandApproval();

    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(
      "Mochi möchte einen Befehl ausführen. pnpm test. Soll ich das erlauben?",
    );
  });

  it("renders command approval actions in German", () => {
    setLocale("de");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(PendingApprovalActions, {
        pending,
        threadId: "thread-1",
        bot: { id: "bot-1", name: "Mochi" } as Bot,
        onCancelTurn: () => undefined,
      }),
    ));

    expect(markup).toContain("Ausführung abbrechen");
    expect(markup).toContain("Ablehnen");
    expect(markup).toContain("Immer erlauben");
    expect(markup).toContain("Einmal erlauben");
    expect(markup).toContain("Bei Mochi nicht mehr nach Bash:pnpm test fragen");
  });
});

/**
 * pt-BR needs another shape for skill approvals: "Should I {action} it?" takes an enclitic pronoun, so the action
 * strings carry it ("atualizá-la").
 */
function skillUpdateApproval(): Pending {
  const message: Message = {
    id: "skill-update-card",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: "Atualizar a habilidade \"lancar-despesa\"?",
      subtitle: "Lança uma despesa no portal da empresa.",
      options: ["Atualizar", "Negar"],
      requestId: "skill-update-request",
      tool: "update_skill",
      skillRequest: {
        version: 1,
        requestId: "skill-update-request",
        botId: "bot-1",
        threadId: "thread-1",
        stagedId: "staged-update",
        action: "update",
        name: "lancar-despesa",
        gist: "Lança uma despesa no portal da empresa.",
        warnings: [],
        createdAt: 1,
      },
    },
  };
  return {
    message,
    requestId: "skill-update-request",
    tool: "update_skill",
    detail: message.card!.subtitle,
  };
}

describe("Brazilian Portuguese approval cards", () => {
  it("renders a pending command approval in Brazilian Portuguese", () => {
    setLocale("pt-BR");
    const { message } = commandApproval();

    const markup = renderToStaticMarkup(createElement(ApprovalCard, {
      bot: { name: "Mochi" } as Bot,
      message,
    }));

    expect(markup).toContain("Mochi quer executar um comando");
    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain("Aguardando sua resposta abaixo");
  });

  it("renders a denied command approval in Brazilian Portuguese", () => {
    setLocale("pt-BR");
    const { message } = commandApproval("deny");

    const markup = renderToStaticMarkup(createElement(ApprovalCard, { message }));

    expect(markup).toContain("Negado");
  });

  it("renders the pending approval strip in Brazilian Portuguese", () => {
    setLocale("pt-BR");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, {
      pending,
      count: 3,
      index: 1,
    }));

    expect(markup).toContain('aria-label="Aprovação pendente"');
    expect(markup).toContain("Aprovação pendente");
    expect(markup).toContain("2 de 3");
    expect(markup).toContain("Pedido de aprovação: comando");
    expect(markup).toContain('aria-label="Detalhes da aprovação para revisar"');
  });

  it("speaks a command approval in Brazilian Portuguese", () => {
    setLocale("pt-BR");
    const { pending } = commandApproval();

    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(
      "Mochi quer executar um comando. pnpm test. Devo permitir?",
    );
  });

  it.each([
    ["enable", "Turn on", "Ligar"],
    ["update", "Change", "Alterar"],
    ["remove", "Remove", "Remover"],
  ] as const)("localizes the spoken and visible MCP %s actions while preserving wire options", (action, english, portuguese) => {
    const { pending } = commandApproval();
    const card = pending.message.card!;
    card.title = `${english} linear?`;
    card.options = [english];
    card.mcpRequest = { requestId: "mcp-request", botId: "bot-1", threadId: "thread-1", action, name: "linear", targetHash: "0".repeat(64) };
    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(`Mochi: ${english} linear? Review the details and choose ${english} or Cancel.`);
    setLocale("pt-br");
    card.title = `${portuguese} linear?`;
    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(`Mochi: ${portuguese} linear? Confira os detalhes e escolha ${portuguese} ou Cancelar.`);
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(PendingApprovalActions, {
      pending, threadId: "thread-1", onCancelTurn: () => undefined,
    })));
    expect(markup).toContain(`>${portuguese}</button>`);
    expect(markup).toContain(">Cancelar</button>");
    expect(card.options).toEqual([english]);
  });

  it.each([
    [false, "Apply setup", "Aplicar configuração"],
    [true, "Delete bot", "Excluir bot"],
  ] as const)("localizes team setup actions with deletion=%s without translating wire options", (deletion, english, portuguese) => {
    const { pending } = commandApproval();
    const card = pending.message.card!;
    card.title = "Review this change?";
    card.options = [english, "Cancel"];
    card.teamSetupRequest = {
      version: 1, requestId: "team-request", botId: "bot-1", threadId: "thread-1", reason: "Team update", createdAt: 1,
      requesterRevision: "rev-1", operations: [], newTeams: [],
      ...(deletion ? { deletion: { botId: "bot-2", name: "Scout", expectedRevision: "rev-2" } } : {}),
    };
    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(`Mochi: Review this change? Review the details and choose ${english} or Cancel.`);
    setLocale("pt-br");
    card.title = "Revisar esta alteração?";
    expect(spokenApprovalPrompt(pending, "Mochi")).toBe(`Mochi: Revisar esta alteração? Confira os detalhes e escolha ${portuguese} ou Cancelar.`);
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(PendingApprovalActions, {
      pending, threadId: "thread-1", onCancelTurn: () => undefined,
    })));
    expect(markup).toContain(`>${portuguese}</button>`);
    expect(markup).toContain(">Cancelar</button>");
    expect(card.options).toEqual([english, "Cancel"]);
  });

  it("speaks a skill approval with the pronoun attached to the verb", () => {
    setLocale("pt-BR");

    expect(spokenApprovalPrompt(skillUpdateApproval(), "Mochi")).toBe(
      "Mochi pergunta: Atualizar a habilidade \"lancar-despesa\"? "
        + "Confira a habilidade na tela. Devo atualizá-la?",
    );
  });

  it("renders command approval actions in Brazilian Portuguese", () => {
    setLocale("pt-BR");
    const { pending } = commandApproval();

    const markup = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(PendingApprovalActions, {
        pending,
        threadId: "thread-1",
        bot: { id: "bot-1", name: "Mochi" } as Bot,
        onCancelTurn: () => undefined,
      }),
    ));

    expect(markup).toContain("Cancelar sessão");
    expect(markup).toContain("Negar");
    expect(markup).toContain("Sempre permitir");
    expect(markup).toContain("Permitir uma vez");
    expect(markup).toContain("Não perguntar mais a Mochi sobre Bash:pnpm test");
  });
});
