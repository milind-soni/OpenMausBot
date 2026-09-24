import { z } from "zod";

/** Tier-1 behavior eval fixtures. A scenario is pure data: the bots to
 * create (with the scripted model turns each one replays), the driver
 * steps that act on the real harness server, and the assertions checked
 * against the collected evidence. Scenarios never contain code, so a
 * fixture cannot reach around the harness under test. */

export const scriptedToolCallSchema = z.object({
  /** Defaults to coordinate_bots, the fixture's workhorse. */
  tool: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  /** The scripted model asks for something the harness refuses. */
  expectError: z.boolean().optional(),
});

export const scriptedTurnSchema = z.object({
  /** Tool calls the scripted model makes, in order. */
  steps: z.array(scriptedToolCallSchema).optional(),
  /** The text the model answers with once its steps (and gate) are done. */
  reply: z.string().optional(),
  /** Hold the turn open until the named gate file exists. This is how a
   * scenario keeps a bot deterministically busy without timing sleeps. */
  gate: z.string().optional(),
  delayMs: z.number().optional(),
  fail: z.boolean().optional(),
});

export const scenarioBotSchema = z.object({
  /** Referenced from steps and scripted arguments as "@key". */
  key: z.string(),
  name: z.string(),
  section: z.string().optional(),
  chiefOfStaff: z.boolean().optional(),
  managedSections: z.array(z.string()).optional(),
  acknowledgePeerScope: z.boolean().optional(),
  computer: z.enum(["vm", "browser", "off"]).optional(),
  browser: z.boolean().optional(),
  /** The scripted turns this bot replays, in order. */
  turns: z.array(scriptedTurnSchema),
});

export const stepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), bot: z.string(), text: z.string() }),
  z.object({ kind: z.literal("waitForTurns"), bot: z.string(), count: z.number().int(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("waitForNodeStatus"), bot: z.string(), status: z.string(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("waitForBusy"), bot: z.string(), busy: z.boolean(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("waitForActivity"), bot: z.string(), namePrefix: z.string(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("createRoutine"), routine: z.string(), bot: z.string(), prompt: z.string() }),
  z.object({ kind: z.literal("runRoutine"), routine: z.string() }),
  z.object({ kind: z.literal("snapshotRoutineRun"), routine: z.string(), saveAs: z.string() }),
  z.object({ kind: z.literal("waitForRoutineRun"), routine: z.string(), status: z.string(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("writeGate"), gate: z.string() }),
  /** Applied before the first turn: pins admission preconditions (for
   * example threads.maxConcurrentPerBot) the scenario's behavior needs. */
  z.object({ kind: z.literal("setConfig"), config: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("setVmState"), state: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("consumeDump"), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("captureComputer"), bot: z.string() }),
  z.object({ kind: z.literal("pollComputerGate"), bot: z.string(), saveAs: z.string() }),
]);

export const assertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sendNotQueued"), bot: z.string() }),
  z.object({ kind: z.literal("toolCalls"), bot: z.string(), equals: z.array(scriptedToolCallSchema) }),
  z.object({ kind: z.literal("turnOrder"), bots: z.array(z.string()) }),
  z.object({ kind: z.literal("systemPromptIncludes"), bot: z.string(), turn: z.number().int(), includes: z.string() }),
  z.object({ kind: z.literal("promptIncludes"), bot: z.string(), turn: z.number().int(), includes: z.string() }),
  z.object({
    kind: z.literal("handoffTree"),
    equals: z.array(z.object({ bot: z.string(), status: z.string(), hasParent: z.boolean().optional() })),
  }),
  z.object({ kind: z.literal("transcriptIncludes"), bot: z.string(), thread: z.enum(["active", "node"]), text: z.string() }),
  z.object({
    kind: z.literal("gateAnswer"),
    of: z.string(),
    held: z.boolean().optional(),
    blockedReasonIncludes: z.string().optional(),
    blockedReasonOmits: z.string().optional(),
    /** Pins the HTTP status a saved gate observation answered with, for
     * answers whose failure mode is the status itself (a revoked bridge
     * capability answers 401 with no held or blockedReason body). */
    httpStatus: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("routineRunSnapshot"), of: z.string(), status: z.string(), deferred: z.boolean() }),
  z.object({ kind: z.literal("activitySeen"), bot: z.string(), namePrefix: z.string() }),
  z.object({ kind: z.literal("noActivityPrefix"), bot: z.string(), prefix: z.string() }),
  /** Pins how many activities with a prefix were recorded, so a terminal
   * error can be required to land exactly once, not merely at least once.
   * The snapshot merges proven waitForActivity prefixes into the list, so
   * a scenario pinning an exact count must not also waitForActivity on the
   * same prefix (order steps off another observable instead). */
  z.object({ kind: z.literal("activityCount"), bot: z.string(), prefix: z.string(), count: z.number().int() }),
]);

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** One sentence stating the behavior this scenario pins. */
  behavior: z.string(),
  issue: z.number().optional(),
  world: z.enum(["coordination", "localVm"]),
  /** Gate keys the scenario uses; the runner materializes each as a file. */
  gates: z.array(z.string()).default([]),
  bots: z.array(scenarioBotSchema),
  steps: z.array(stepSchema),
  assertions: z.array(assertionSchema),
});

export type ScriptedToolCall = z.infer<typeof scriptedToolCallSchema>;
export type ScriptedTurn = z.infer<typeof scriptedTurnSchema>;
export type ScenarioBot = z.infer<typeof scenarioBotSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
