// A conversation message as the OpenMausBot MCP server shows it to an agent: its text plus the state of any card on it.
export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function projectMessage(message: Record<string, any>) {
  const card = isRecord(message.card)
    ? {
        title: message.card.title,
        subtitle: message.card.subtitle,
        options: message.card.options,
        answered: message.card.answered,
        dismissed: message.card.dismissed,
        expired: message.card.expired,
      }
    : undefined;
  const tool = isRecord(message.tool)
    ? { name: message.tool.name, ok: message.tool.ok, spoken: message.tool.spoken, setup: message.tool.setup,
        ...(message.tool.terminal === true ? { terminal: true } : {}),
      }
    : undefined;
  const connector = isRecord(message.connector)
    ? {
        slug: message.connector.slug,
        label: message.connector.label,
        description: message.connector.description,
        status: message.connector.status,
        dismissed: message.connector.dismissed,
        resumed: message.connector.resumed,
      }
    : undefined;
  const secret = isRecord(message.secret)
    ? {
        target: message.secret.target,
        label: message.secret.label,
        description: message.secret.description,
        placeholder: message.secret.placeholder,
        helpUrl: message.secret.helpUrl,
        provided: message.secret.provided,
        dismissed: message.secret.dismissed,
        superseded: message.secret.superseded,
        resumed: message.secret.resumed,
      }
    : undefined;
  const signIn = isRecord(message.signIn)
    ? {
        site: message.signIn.site,
        url: message.signIn.url,
        place: message.signIn.place,
        reason: message.signIn.reason,
        done: message.signIn.done,
        cancelled: message.signIn.cancelled,
        superseded: message.signIn.superseded,
        answeredInChat: message.signIn.answeredInChat,
        resumed: message.signIn.resumed,
      }
    : undefined;
  return {
    id: message.id,
    at: message.at,
    role: message.role,
    kind: message.kind,
    text: message.text,
    from: message.from,
    replyToId: message.replyToId,
    reactions: message.reactions,
    steered: message.steered,
    queued: message.queued,
    ...(tool ? { tool } : {}),
    ...(card ? { card } : {}),
    ...(connector ? { connector } : {}),
    ...(secret ? { secret } : {}),
    ...(signIn ? { signIn } : {}), ...(message.widget ? { widget: message.widget } : {}), ...(message.app ? { app: message.app } : {}), ...(message.fromApp ? { fromApp: message.fromApp } : {}), ...(message.wait ? { wait: message.wait } : {}),
    ...(message.kind === "screen" ? { hasImage: Boolean(message.hasImage || message.png) } : {}),
  };
}
