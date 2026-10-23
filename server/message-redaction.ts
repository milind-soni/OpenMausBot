import { redactSecretsInText } from "./redact.ts";
import { scrubbedSkillRequest } from "./skill-request-card.ts";
import type { ProfileRequestChanges } from "../shared/profile-request.ts";
import type { OptionCardData, WireMessage } from "../shared/wire.ts";

/** Bot-authored text is scrubbed of secrets before it is stored (the transcript replays into every rebuild); what the user typed stays as typed. */
export function redactBotAuthored<T extends Omit<WireMessage, "id" | "at"> & { at?: number }>(message: T): T {
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (out.dataResult) out.dataResult = {
    ...out.dataResult,
    title: redactSecretsInText(out.dataResult.title),
    ...(out.dataResult.sql === undefined ? {} : { sql: redactSecretsInText(out.dataResult.sql) }),
  };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  if (out.compaction) out.compaction = {
    ...out.compaction,
    summary: redactSecretsInText(out.compaction.summary),
    ...(out.compaction.requirements === undefined ? {} : { requirements: out.compaction.requirements.map(item => ({
      ...item, text: redactSecretsInText(item.text),
      ...(item.corrections === undefined ? {} : { corrections: item.corrections.map(row => ({ ...row, text: redactSecretsInText(row.text) })) }),
    })) }),
  };
  if (out.tool?.name) {
    out.tool = { ...out.tool, name: redactSecretsInText(out.tool.name) };
    if (out.tool.summary) out.tool.summary = redactSecretsInText(out.tool.summary);
  }
  if (out.routineRun) {
    const routineRun = { ...out.routineRun };
    routineRun.routineName = redactSecretsInText(routineRun.routineName);
    if (routineRun.summary) routineRun.summary = redactSecretsInText(routineRun.summary);
    if (routineRun.error) routineRun.error = redactSecretsInText(routineRun.error);
    out.routineRun = routineRun;
  }
  if (out.goalRun) {
    out.goalRun = {
      ...out.goalRun,
      goal: redactSecretsInText(out.goalRun.goal),
      coordinatorName: redactSecretsInText(out.goalRun.coordinatorName),
      detail: out.goalRun.detail ? redactSecretsInText(out.goalRun.detail) : undefined,
    };
  }
  if (out.call?.title) out.call = { ...out.call, title: redactSecretsInText(out.call.title) };
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    if (typeof card.held === "string") card.held = redactSecretsInText(card.held);
    if (typeof card.answeredText === "string") card.answeredText = redactSecretsInText(card.answeredText);
    if (card.commandAllowlist && (
      redactSecretsInText(card.commandAllowlist.command) !== card.commandAllowlist.command ||
      redactSecretsInText(card.commandAllowlist.cwd) !== card.commandAllowlist.cwd
    )) delete card.commandAllowlist;
    if (card.questionRequest) {
      card.questionRequest = {
        ...card.questionRequest,
        questions: card.questionRequest.questions.map((question) => ({
          ...question,
          question: redactSecretsInText(question.question),
          ...(question.header ? { header: redactSecretsInText(question.header) } : {}),
          options: question.options.map((option) => ({
            ...option,
            label: redactSecretsInText(option.label),
            ...(option.description ? { description: redactSecretsInText(option.description) } : {}),
          })),
        })),
      };
    }
    if (card.routineRequest) {
      const operation = card.routineRequest.operation;
      card.routineRequest = {
        ...card.routineRequest,
        operation: operation.action === "create"
          ? {
              ...operation,
              routine: {
                ...operation.routine,
                name: redactSecretsInText(operation.routine.name),
                instructions: redactSecretsInText(operation.routine.instructions),
              },
            }
          : operation.action === "update"
            ? {
                ...operation,
                changes: {
                  ...operation.changes,
                  ...(typeof operation.changes.name === "string"
                    ? { name: redactSecretsInText(operation.changes.name) }
                    : {}),
                  ...(typeof operation.changes.instructions === "string"
                    ? { instructions: redactSecretsInText(operation.changes.instructions) }
                    : {}),
                },
              }
            : { ...operation },
      };
    }
    if (card.skillRequest) card.skillRequest = scrubbedSkillRequest(card.skillRequest);
    if (card.profileRequest) {
      const scrubChanges = (changes: ProfileRequestChanges): ProfileRequestChanges => {
        const out = { ...changes };
        for (const [key, value] of Object.entries(changes)) {
          if (typeof value === "string") (out as Record<string, string | boolean>)[key] = redactSecretsInText(value);
        }
        return out;
      };
      card.profileRequest = {
        ...card.profileRequest,
        targetName: redactSecretsInText(card.profileRequest.targetName),
        reason: redactSecretsInText(card.profileRequest.reason),
        before: scrubChanges(card.profileRequest.before),
        changes: scrubChanges(card.profileRequest.changes),
      };
    }
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  if (out.signIn) {
    out.signIn = {
      ...out.signIn,
      reason: out.signIn.reason ? redactSecretsInText(out.signIn.reason) : undefined,
      error: out.signIn.error ? redactSecretsInText(out.signIn.error) : undefined,
    };
  }
  return out;
}
