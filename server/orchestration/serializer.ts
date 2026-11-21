import { createHash } from 'node:crypto';
import type { ArtifactPointer, BotTaskEnvelopeV3 } from './contracts.ts';

export interface SerializedPrompt {
  l0: string;
  l1: string;
  l2: string;
  fullPrompt: string;
  prefixHash: string; // Hash of L0 + L1, used for cache grouping & warmup
}

export interface PromptSerializerOptions {
  staticRoleDefinition: string;
  globalSecurityInvariants?: string;
  frozenMasterContextSnapshot?: string;
  blackboardReadIndex?: Array<{ id: string; title: string; summary: string }>;
}

export class PromptSerializer {
  public static readonly BREAKPOINT_L0_L1 = '<<<-- CACHE_BREAKPOINT_L0_L1 -->>>';
  public static readonly BREAKPOINT_L1_L2 = '<<<-- CACHE_BREAKPOINT_L1_L2 -->>>';

  /**
   * Deterministically serialize envelope into L0, L1, and L2 layers.
   * - L0: Static system role + security rules + output schema. No time/UUID/counters.
   * - L1: Task master plan & shared static index. Excludes incremental version numbers.
   * - L2: Transient slice (subtaskId, attempt, goal, upstream slices, examples, sanitized pointers).
   * Pure metadata (expectedBlackboardVersion, idempotencyKey, limits) are strictly stripped.
   */
  public static serialize(
    envelope: BotTaskEnvelopeV3,
    options: PromptSerializerOptions
  ): SerializedPrompt {
    // ---------------------------------------------------------
    // L0: Static Bot Persona, Global Safety Rules, Output Schema
    // ---------------------------------------------------------
    const securityRules = options.globalSecurityInvariants ?? 
      '1. Strictly adhere to declared scope and forbidden files.\n2. Output only valid SubBotLLMOutput JSON.';
    
    const l0Parts = [
      '# ROLE DEFINITION',
      options.staticRoleDefinition.trim(),
      '',
      '# GLOBAL SECURITY INVARIANTS',
      securityRules.trim(),
      '',
      '# OUTPUT CONTRACT REQUIREMENT',
      'You MUST conclude your response with a JSON object conforming strictly to SubBotLLMOutput:',
      '{"outcome": "COMPLETED" | "CONTRACT_CONFLICT", "outputData"?: Record<string, unknown>, "conflictEvidence"?: string}',
      'Do NOT fabricate tokens, execution times, diff counts, or retry strikes. Those are recorded by the runtime harness.',
    ];
    const l0 = l0Parts.join('\n');

    // ---------------------------------------------------------
    // L1: Frozen Task Master Context & Read-Only Blackboard Index
    // (Notice: NO incrementing blackboard version, NO dynamic timestamps!)
    // ---------------------------------------------------------
    const masterContext = options.frozenMasterContextSnapshot ?? 'Default Task Master Snapshot';
    const indexLines = (options.blackboardReadIndex ?? []).map(
      (item) => `- [${item.id}] ${item.title}: ${item.summary}`
    );

    const l1Parts = [
      '# PARENT TASK CONTEXT',
      `Parent Task ID: ${envelope.parentTaskId}`,
      '',
      '## FROZEN MASTER TASK SNAPSHOT',
      masterContext.trim(),
      '',
      '## BLACKBOARD READ-ONLY INDEX',
      indexLines.length > 0 ? indexLines.join('\n') : '(No shared artifacts currently indexed)',
    ];
    const l1 = l1Parts.join('\n');

    // ---------------------------------------------------------
    // L2: Ephemeral Subtask Execution Slice
    // ---------------------------------------------------------
    const pointersSanitized = (envelope.artifactPointers ?? []).map((p: ArtifactPointer) => ({
      id: p.id,
      summary: p.summary,
      lineRange: p.lineRange,
    }));

    const l2Parts = [
      '# SUBTASK EXECUTION SLICE',
      `Subtask ID: ${envelope.subtaskId}`,
      `Attempt: ${envelope.attempt}`,
      `Tier: ${envelope.tier}`,
      `Goal: ${envelope.goal}`,
      '',
      '## EXECUTION PROFILE',
      JSON.stringify(envelope.executionProfile, null, 2),
      '',
      '## UPSTREAM CONTEXT SLICES',
      JSON.stringify(envelope.context.upstreamSlices, null, 2),
      '',
      '## CONTRACT RULES',
      envelope.context.contractRules.map((r: string, i: number) => `${i + 1}. ${r}`).join('\n'),
      '',
      '## FORBIDDEN SCOPE',
      envelope.context.forbiddenScope.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n'),
    ];

    if (envelope.context.examples) {
      l2Parts.push('', '## EXAMPLES');
      l2Parts.push(`[GOOD ALIGNMENT EXAMPLE]:\n${envelope.context.examples.good}`);
      if (envelope.context.examples.bad) {
        l2Parts.push(`[BAD COUNTER EXAMPLE]:\n${envelope.context.examples.bad}`);
      }
    }

    if (pointersSanitized.length > 0) {
      l2Parts.push('', '## REFERENCED ARTIFACT POINTERS');
      l2Parts.push(
        'Call read_artifact({ id }) using the exact ID below. Raw disk paths and hashes are resolved by the runtime harness:'
      );
      l2Parts.push(JSON.stringify(pointersSanitized, null, 2));
    }

    l2Parts.push('', '## ACCEPTANCE CRITERIA (DoD)');
    l2Parts.push(`Verifier: ${envelope.acceptanceCriteria.verifierType}`);
    l2Parts.push(`Schema: ${envelope.acceptanceCriteria.outputSchemaName}`);
    l2Parts.push('Required Checks:');
    l2Parts.push(envelope.acceptanceCriteria.checks.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n'));

    const l2 = l2Parts.join('\n');

    const prefix = `${l0}\n\n${PromptSerializer.BREAKPOINT_L0_L1}\n\n${l1}`;
    const fullPrompt = `${prefix}\n\n${PromptSerializer.BREAKPOINT_L1_L2}\n\n${l2}`;

    const prefixHash = createHash('sha256').update(prefix, 'utf8').digest('hex');

    return {
      l0,
      l1,
      l2,
      fullPrompt,
      prefixHash,
    };
  }
}
