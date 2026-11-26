import {
  type BotTaskEnvelopeV3,
  type BotHandoffDeltaV3,
  type SubBotLLMOutput,
  SubBotLLMOutputSchema,
  BotHandoffDeltaV3Schema,
} from './contracts.ts';

export interface ArtifactResolver {
  resolve(uri: string): { exists: boolean; sha256?: string; content?: string };
}

export interface VerificationCheckResult {
  passed: boolean;
  verifierType: 'CODE_TEST' | 'SCHEMA_RULE' | 'INDEPENDENT_CRITIC';
  summary: string;
  errorSnippet?: string;
}

export interface HarnessExecutionInput {
  envelope: BotTaskEnvelopeV3;
  currentStrikeCount: 0 | 1 | 2;
  rawLLMOutput: unknown;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  artifactResolver?: ArtifactResolver;
  verificationFn?: (output: SubBotLLMOutput) => VerificationCheckResult;
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    patchUri?: string;
  };
}

export class RuntimeHarness {
  /**
   * Check if any referenced artifact pointers have become stale or missing.
   * If stale, returns the stale pointer ID.
   */
  public static checkArtifactPointers(
    envelope: BotTaskEnvelopeV3,
    resolver: ArtifactResolver
  ): { stale: boolean; stalePointerId?: string } {
    if (!envelope.artifactPointers || envelope.artifactPointers.length === 0) {
      return { stale: false };
    }

    for (const pointer of envelope.artifactPointers) {
      const resolved = resolver.resolve(pointer.uri);
      if (!resolved.exists || !resolved.sha256 || resolved.sha256 !== pointer.sha256) {
        return { stale: true, stalePointerId: pointer.id };
      }
    }

    return { stale: false };
  }

  /**
   * Process and package LLM response with deterministic telemetry, strike state machine,
   * verification DoD, and soft diff warning checks.
   */
  public static processHandoff(input: HarnessExecutionInput): BotHandoffDeltaV3 {
    const {
      envelope,
      currentStrikeCount,
      rawLLMOutput,
      durationMs,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      artifactResolver,
      verificationFn,
      diffStats,
    } = input;

    const cacheHitRate = inputTokens > 0 ? Math.min(1, Math.max(0, cachedInputTokens / inputTokens)) : 0;
    const telemetry = {
      durationMs: Math.max(0, durationMs),
      inputTokens: Math.max(0, inputTokens),
      cachedInputTokens: Math.max(0, cachedInputTokens),
      outputTokens: Math.max(0, outputTokens),
      cacheHitRate: Number(cacheHitRate.toFixed(4)),
    };

    // 1. Check Artifact Staleness (Underlying hash mismatch)
    if (artifactResolver) {
      const { stale, stalePointerId } = this.checkArtifactPointers(envelope, artifactResolver);
      if (stale) {
        return BotHandoffDeltaV3Schema.parse({
          subtaskId: envelope.subtaskId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'STALE_POINTER',
          strikeCount: currentStrikeCount, // Does not burn strikes
          verification: {
            passed: false,
            verifierType: envelope.acceptanceCriteria.verifierType,
            summary: `Stale artifact pointer detected: ${stalePointerId}. Refreshing context.`,
          },
          telemetry,
          diagnostics: {
            errorSnippet: `Artifact pointer ${stalePointerId} hash mismatch or target missing.`,
            traceLogUri: `logs/${envelope.parentTaskId}/${envelope.subtaskId}/stale-pointer.log`,
          },
        });
      }
    }

    // 2. Validate LLM Output Schema
    const parsedLLM = SubBotLLMOutputSchema.safeParse(rawLLMOutput);
    if (!parsedLLM.success) {
      const nextStrike = Math.min(2, currentStrikeCount + 1) as 0 | 1 | 2;
      const isBroken = nextStrike >= 2;
      return BotHandoffDeltaV3Schema.parse({
        subtaskId: envelope.subtaskId,
        idempotencyKey: envelope.idempotencyKey,
        status: isBroken ? 'CIRCUIT_BROKEN' : 'NEED_RETRY',
        strikeCount: nextStrike,
        verification: {
          passed: false,
          verifierType: 'SCHEMA_RULE',
          summary: 'SubBotLLMOutput JSON schema validation failed.',
        },
        telemetry,
        diagnostics: {
          errorSnippet: parsedLLM.error.message.slice(0, 2048),
          traceLogUri: `logs/${envelope.parentTaskId}/${envelope.subtaskId}/schema-err-${envelope.attempt}.log`,
        },
      });
    }

    const subBotOutput = parsedLLM.data;

    // 3. Handle CONTRACT_CONFLICT cleanly (Clean Pause)
    if (subBotOutput.outcome === 'CONTRACT_CONFLICT') {
      return BotHandoffDeltaV3Schema.parse({
        subtaskId: envelope.subtaskId,
        idempotencyKey: envelope.idempotencyKey,
        status: 'CONTRACT_CONFLICT',
        strikeCount: currentStrikeCount, // Does not penalize subagent
        verification: {
          passed: false,
          verifierType: envelope.acceptanceCriteria.verifierType,
          summary: 'SubBot raised CONTRACT_CONFLICT due to inconsistent upstream specifications.',
        },
        telemetry,
        diagnostics: {
          errorSnippet: 'CONTRACT_CONFLICT reported by agent.',
          conflictEvidence: subBotOutput.conflictEvidence ?? 'No detailed conflict evidence provided.',
          traceLogUri: `logs/${envelope.parentTaskId}/${envelope.subtaskId}/conflict.log`,
        },
      });
    }

    // 4. Verification Check
    const verifyResult: VerificationCheckResult = verificationFn
      ? verificationFn(subBotOutput)
      : {
          passed: true,
          verifierType: envelope.acceptanceCriteria.verifierType,
          summary: 'Verification succeeded by default schema rules.',
        };

    // Calculate diff warning if engineering profile
    let engineeringStats: BotHandoffDeltaV3['engineeringStats'] = undefined;
    if (envelope.executionProfile.kind === 'ENGINEERING') {
      const stats = diffStats ?? { filesChanged: 0, insertions: 0, deletions: 0 };
      const totalDiff = stats.insertions + stats.deletions;
      const budgetLimit = envelope.executionProfile.softDiffWarningLines;
      engineeringStats = {
        filesChanged: stats.filesChanged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        diffBudgetExceeded: totalDiff > budgetLimit,
        patchUri: stats.patchUri,
      };
    }

    if (!verifyResult.passed) {
      const nextStrike = Math.min(2, currentStrikeCount + 1) as 0 | 1 | 2;
      const isBroken = nextStrike >= 2;
      return BotHandoffDeltaV3Schema.parse({
        subtaskId: envelope.subtaskId,
        idempotencyKey: envelope.idempotencyKey,
        status: isBroken ? 'CIRCUIT_BROKEN' : 'NEED_RETRY',
        strikeCount: nextStrike,
        outputData: subBotOutput.outputData,
        engineeringStats,
        verification: {
          passed: false,
          verifierType: verifyResult.verifierType,
          summary: verifyResult.summary.slice(0, 400),
        },
        telemetry,
        diagnostics: {
          errorSnippet: (verifyResult.errorSnippet ?? 'Verification failed.').slice(0, 2048),
          traceLogUri: `logs/${envelope.parentTaskId}/${envelope.subtaskId}/verify-fail-${envelope.attempt}.log`,
        },
      });
    }

    // 5. Success
    return BotHandoffDeltaV3Schema.parse({
      subtaskId: envelope.subtaskId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'SUCCESS',
      strikeCount: currentStrikeCount,
      outputData: subBotOutput.outputData,
      engineeringStats,
      verification: {
        passed: true,
        verifierType: verifyResult.verifierType,
        summary: verifyResult.summary.slice(0, 400),
      },
      telemetry,
    });
  }
}
