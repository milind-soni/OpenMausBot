// What a live ACP session last confirmed for each session config option the driver set (a permission mode, a thinking
// level), so a turn that asks for the same value sends no `session/set_config_option` again.
//
// Adapted from pingdotgg/t3code@38067630229, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in
// third_party/t3-code/LICENSE); modified: packages/provider-acp/src/server/adapter.ts (configureSession runs only when
// the model, interaction mode or runtime mode changed) and AcpSessionRuntime.ts (each setter skips the RPC when the value
// already matches) become one per-session record. A value is skipped only when this session confirmed it AND the
// session's latest reported options still say so; the record is forgotten when the session is new, loaded or resumed,
// when the model is switched, when the agent reports a config change between turns, and when a call fails.

export class AppliedConfig {
  private readonly values = new Map<string, string>();

  /** This session confirmed `value` for `configId`, and the options it reported last still hold it. */
  holds(configId: string, value: string, reported: unknown): boolean {
    return this.values.get(configId) === value && reported === value;
  }

  accepted(configId: string, value: string): void {
    this.values.set(configId, value);
  }

  clear(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }
}

/** The `currentValue` of one option in a session's `configOptions`, as the agent reported it last. */
export function reportedConfigValue(configOptions: unknown, configId: string): unknown {
  return Array.isArray(configOptions) ? configOptions.find((option: any) => option?.id === configId)?.currentValue : undefined;
}
