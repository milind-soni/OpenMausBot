import type { EffortLevel, ModelCatalog, ModelSelection } from "./contracts.ts";

export type WorkerEffortOverride = EffortLevel | "default";

export interface WorkerSelectionOverride {
  engineId?: string;
  model?: string;
  effort?: WorkerEffortOverride;
}

export interface WorkerEngineChoice {
  instanceId: string;
  driverKind?: string;
  displayName?: string;
  models: ModelCatalog;
  effortLevels?: readonly EffortLevel[];
}

export type WorkerSelectionResult =
  | { ok: true; selection: ModelSelection }
  | { ok: false; error: string };

interface ModelChoice {
  id: string;
  label: string;
}

type ModelResolution =
  | { ok: true; model: string }
  | { ok: false; error: string };

const CODEX_DRIVER = "codex";
const CODEX_COORDINATOR_MODEL = "gpt-5.6-sol";
const CODEX_EXECUTOR_MODEL = "gpt-5.6-luna";

function offersModel(engine: Readonly<WorkerEngineChoice>, model: string): boolean {
  return catalogChoices(engine).some((choice) => choice.id === model);
}

function preferredEffort(engine: Readonly<WorkerEngineChoice>): EffortLevel | undefined {
  return engine.effortLevels?.includes("high") ? "high" : undefined;
}

function selectionWithEffort(
  instanceId: string,
  model: string,
  effort: EffortLevel | undefined,
): ModelSelection {
  const selection: ModelSelection = { instanceId, model };
  if (effort) selection.effort = effort;
  return selection;
}

/** One source of truth for the default Codex coordinator route. Other
 * engines keep their own catalog default and CLI-default effort. */
export function preferredCoordinatorSelection(
  engine: Readonly<WorkerEngineChoice>,
): ModelSelection {
  const codex = engine.driverKind === CODEX_DRIVER;
  const model = codex && offersModel(engine, CODEX_COORDINATOR_MODEL)
    ? CODEX_COORDINATOR_MODEL
    : engine.models.default;
  const effort = codex ? preferredEffort(engine) : undefined;
  return selectionWithEffort(engine.instanceId, model, effort);
}

function catalogChoices(engine: WorkerEngineChoice): ModelChoice[] {
  const byId = new Map<string, ModelChoice>();
  if (engine.models.default.trim()) {
    byId.set(engine.models.default, { id: engine.models.default, label: engine.models.default });
  }
  for (const option of engine.models.options) {
    byId.set(option.id, { id: option.id, label: option.label });
  }
  return [...byId.values()];
}

function resolveModel(query: string, engine: WorkerEngineChoice): ModelResolution {
  const requested = query.trim();
  const normalized = requested.toLocaleLowerCase();
  const choices = catalogChoices(engine);
  const exactId = choices.find((choice) => choice.id === requested)
    ?? choices.find((choice) => choice.id.toLocaleLowerCase() === normalized);
  if (exactId) return { ok: true, model: exactId.id };

  const exactLabel = choices.filter((choice) => choice.label.toLocaleLowerCase() === normalized);
  if (exactLabel.length === 1 && exactLabel[0]) return { ok: true, model: exactLabel[0].id };

  const fragments = choices.filter((choice) =>
    choice.label.toLocaleLowerCase().includes(normalized)
    || choice.id.toLocaleLowerCase().includes(normalized)
  );
  if (fragments.length === 1 && fragments[0]) return { ok: true, model: fragments[0].id };

  const engineName = engine.displayName?.trim() || engine.instanceId;
  if (fragments.length > 1) {
    const examples = fragments.slice(0, 5).map((choice) => choice.label).join(", ");
    return { ok: false, error: `model "${requested}" is ambiguous on ${engineName}: ${examples}` };
  }
  return { ok: false, error: `model "${requested}" is not available on ${engineName}` };
}

/** Resolve one temporary worker's engine/model at the launch seam. Nothing
 * inside the worker needs to understand aliases or inheritance, and invalid
 * choices fail before any job is queued. */
export function resolveWorkerModelSelection(
  owner: Readonly<ModelSelection>,
  override: Readonly<WorkerSelectionOverride>,
  engine: Readonly<WorkerEngineChoice>,
): WorkerSelectionResult {
  const targetInstanceId = override.engineId?.trim() || owner.instanceId;
  if (engine.instanceId !== targetInstanceId) {
    return { ok: false, error: `engine "${targetInstanceId}" is unavailable` };
  }

  let model: string;
  if (override.model?.trim()) {
    const resolved = resolveModel(override.model, engine);
    if (!resolved.ok) return resolved;
    model = resolved.model;
  } else if (engine.driverKind === CODEX_DRIVER && offersModel(engine, CODEX_EXECUTOR_MODEL)) {
    model = CODEX_EXECUTOR_MODEL;
  } else if (targetInstanceId === owner.instanceId) {
    model = owner.model;
  } else {
    model = engine.models.default;
  }
  if (!model.trim()) return { ok: false, error: `engine "${targetInstanceId}" has no default model` };

  let effort: EffortLevel | undefined;
  if (override.effort === "default") {
    effort = undefined;
  } else if (override.effort !== undefined) {
    if (!engine.effortLevels?.includes(override.effort)) {
      return {
        ok: false,
        error: `effort "${override.effort}" is not offered by ${engine.displayName?.trim() || engine.instanceId}`,
      };
    }
    effort = override.effort;
  } else if (engine.driverKind === CODEX_DRIVER && preferredEffort(engine)) {
    effort = preferredEffort(engine);
  } else if (targetInstanceId === owner.instanceId) {
    effort = owner.effort;
  }

  return { ok: true, selection: selectionWithEffort(targetInstanceId, model, effort) };
}
