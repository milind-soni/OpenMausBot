export function kiroShouldDropUpdate(u: Record<string, unknown>, p: { sessionId?: unknown }, handleNotification: Function): boolean {
  if (u.sessionUpdate === "session_info_update") {
    const kiro = (u as { _meta?: { kiro?: { kind?: unknown } } })._meta?.kiro;
    const kind = typeof kiro?.kind === "string" ? kiro.kind : undefined;
    if (kind === "steering_injected") {
      const m = ((handleNotification as unknown as { _kiroSteering?: Map<string, boolean> })._kiroSteering ??= new Map());
      m.set(String(p.sessionId ?? ""), true);
    } else if (kind === "steering_cleared") {
      (handleNotification as unknown as { _kiroSteering?: Map<string, boolean> })._kiroSteering?.delete(String(p.sessionId ?? ""));
    }
  }
  const toolId = (u as { _meta?: { kiro?: { toolId?: unknown } } })._meta?.kiro?.toolId;
  if (toolId === "fetch_cloud_config") {
    const key = `${String(p.sessionId ?? "")}\n${String((u as { toolCallId?: unknown }).toolCallId ?? "")}`;
    ((handleNotification as unknown as { _kiroCloud?: Set<string> })._kiroCloud ??= new Set()).add(key);
    return true;
  }
  if (u.sessionUpdate === "tool_call_update" || u.sessionUpdate === "tool_call_content_chunk") {
    const key = `${String(p.sessionId ?? "")}\n${String((u as { toolCallId?: unknown }).toolCallId ?? "")}`;
    const set = (handleNotification as unknown as { _kiroCloud?: Set<string> })._kiroCloud;
    if (set?.has(key)) {
      if (u.status === "completed" || u.status === "failed") set.delete(key);
      return true;
    }
  }
  return false;
}

export function kiroFilterDelta(delta: string): string | null {
  if (delta.includes("[STEERING steer-")) {
    const filtered = delta.split("[STEERING steer-")[0].trimEnd();
    if (!filtered) return null;
    return filtered;
  }
  return delta;
}

export function kiroConsentMeta(params: { _meta?: { kiro?: { consent?: { resource?: string; triggeringResource?: string; workspaceRoot?: string; scope?: string } } } }, cwd: string, forSession: boolean, optionAlways: string | null, optionId: string | null): { kiro: { consent: { scope: string; resource: string; workspaceRoot: string } } } | undefined {
  const src = params?._meta?.kiro?.consent;
  if (forSession && optionAlways && optionId === optionAlways && src?.resource) {
    return { kiro: { consent: { scope: src.scope ?? "workspace", resource: src.resource, workspaceRoot: src.workspaceRoot ?? cwd } } };
  }
  return undefined;
}
