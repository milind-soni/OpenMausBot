import type { Scenario } from "../types.ts";
import { evaluateAssertions } from "../scorers/assertions.ts";
import type { ScenarioResult, StepResult, WorldSnapshot } from "../scorers/snapshot.ts";
import type { SendReceipt } from "../scorers/snapshot.ts";
import { BaseWorld, type WorldContext } from "./base-world.ts";
import { CoordinationWorld } from "./coordination-world.ts";
import { LocalVmWorld } from "./local-vm-world.ts";

/** Runs one scenario against a freshly booted real server and returns the
 * frozen evidence plus every assertion verdict. The world is torn down even
 * when a step fails, so a failing run still reports the steps that passed. */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const world: BaseWorld = scenario.world === "coordination" ? new CoordinationWorld() : new LocalVmWorld();
  const ctx: WorldContext = { sends: [] as SendReceipt[], observations: {} };
  const steps: StepResult[] = [];
  let snapshot: WorldSnapshot | undefined;
  let error: string | undefined;
  try {
    await world.boot(scenario);
    for (const step of scenario.steps) {
      const stepStart = Date.now();
      try {
        const detail = await world.runStep(step, ctx);
        steps.push({ step, ok: true, detail, durationMs: Date.now() - stepStart });
      } catch (failure) {
        steps.push({
          step,
          ok: false,
          detail: failure instanceof Error ? failure.message : String(failure),
          durationMs: Date.now() - stepStart,
        });
        throw failure;
      }
    }
    snapshot = await world.snapshot(ctx);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    await world.close().catch(() => undefined);
  }
  const assertions = snapshot === undefined ? [] : evaluateAssertions(scenario.assertions, snapshot);
  return {
    id: scenario.id,
    title: scenario.title,
    behavior: scenario.behavior,
    world: scenario.world,
    pass: error === undefined && assertions.every((assertion) => assertion.pass),
    startedAt,
    durationMs: Date.now() - start,
    steps,
    assertions,
    assertionsInput: scenario.assertions,
    ...(error === undefined ? {} : { error }),
  };
}
