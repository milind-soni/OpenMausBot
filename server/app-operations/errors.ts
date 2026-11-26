export type AppOperationErrorCode =
  | "unknown_operation" | "invalid_input" | "needs_click" | "busy" | "timeout" | "statement_timeout" | "runtime_stopped"
  | "runtime_unavailable" | "database_stopped" | "read_only" | "sql_error" | "invalid_params" | "too_large"
  | "not_declared" | "connectors_unavailable" | "operation_failed" | "migration_failed" | "migration_newer" | "app_invalid"
  | "forbidden" | "memory";

export class AppOperationError extends Error {
  readonly code: string;
  constructor(code: AppOperationErrorCode | string, message: string) {
    super(message);
    this.code = code;
  }
}
