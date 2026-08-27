export interface DingTalkCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DingTalkCredentialProvider {
  load(): DingTalkCredentials | null;
}

export type DingTalkConfigurationState =
  | { enabled: false; configured: false; state: "disabled" }
  | { enabled: true; configured: false; state: "needs_configuration"; missing: string[] }
  | {
      enabled: true;
      configured: true;
      state: "ready";
      proactiveOpenConversationId?: string;
      cardTemplateId?: string;
    };

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export class EnvironmentDingTalkCredentialProvider implements DingTalkCredentialProvider {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.environment = environment;
  }

  load(): DingTalkCredentials | null {
    const clientId = trimmed(this.environment.OMB_DINGTALK_CLIENT_ID);
    const clientSecret = trimmed(this.environment.OMB_DINGTALK_CLIENT_SECRET);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
}

export function readDingTalkConfiguration(environment: NodeJS.ProcessEnv = process.env): DingTalkConfigurationState {
  if (environment.OMB_DINGTALK_ENABLED !== "1") return { enabled: false, configured: false, state: "disabled" };
  const missing: string[] = [];
  if (!trimmed(environment.OMB_DINGTALK_CLIENT_ID)) missing.push("OMB_DINGTALK_CLIENT_ID");
  if (!trimmed(environment.OMB_DINGTALK_CLIENT_SECRET)) missing.push("OMB_DINGTALK_CLIENT_SECRET");
  if (missing.length) return { enabled: true, configured: false, state: "needs_configuration", missing };
  return {
    enabled: true,
    configured: true,
    state: "ready",
    ...(trimmed(environment.OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID)
      ? { proactiveOpenConversationId: trimmed(environment.OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID) }
      : {}),
    ...(trimmed(environment.OMB_DINGTALK_CARD_TEMPLATE_ID)
      ? { cardTemplateId: trimmed(environment.OMB_DINGTALK_CARD_TEMPLATE_ID) }
      : {}),
  };
}
