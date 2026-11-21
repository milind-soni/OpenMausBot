import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  type BotTaskEnvelopeV3,
  type IntraBotSubagentEnvelope,
  type IntraBotBatchRequest,
  SubBotLLMOutputSchema,
  BotTaskEnvelopeV3Schema,
  PromptSerializer,
  RuntimeHarness,
  IntraBotSubagentManager,
} from './index.ts';

describe('Tier-0 Orchestration Architecture Test Suite', () => {
  const sampleEnvelope: BotTaskEnvelopeV3 = {
    parentTaskId: 'TASK-PARENT-100',
    expectedBlackboardVersion: 3,
    idempotencyKey: 'subtask-a:attempt-1',
    limits: {
      maxExecutionTokens: 16000,
      maxToolCalls: 20,
      timeoutMs: 60000,
    },
    subtaskId: 'subtask-a',
    attempt: 1,
    tier: 'T2_STANDARD',
    goal: 'Implement user profile validation endpoint',
    executionProfile: {
      kind: 'ENGINEERING',
      worktreePath: '/tmp/worktree-a',
      branchName: 'feature/profile-val',
      softDiffWarningLines: 400,
    },
    context: {
      upstreamSlices: {
        userModel: { id: 'string', email: 'string' },
      },
      contractRules: [
        'Validate email format with RFC 5322 standard',
        'Reject passwords shorter than 8 characters',
      ],
      forbiddenScope: ['src/auth/session.ts', 'config/database.ts'],
      examples: {
        good: 'export function validateEmail(email: string): boolean { return /^[^@]+@[^@]+$/.test(email); }',
        bad: 'export function validateEmail(email: string) { return true; }',
      },
    },
    artifactPointers: [
      {
        id: 'ART-01',
        summary: 'Database user schema definition',
        uri: 'file:///workspace/models/user.ts',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        lineRange: 'L10-L45',
      },
    ],
    acceptanceCriteria: {
      outputSchemaName: 'SubBotLLMOutputSchema',
      verifierType: 'CODE_TEST',
      checks: ['pnpm test user-profile', 'pnpm tsc --noEmit'],
    },
  };

  describe('1. Contracts & Schema Physical Decoupling', () => {
    it('should validate complete BotTaskEnvelopeV3', () => {
      const parsed = BotTaskEnvelopeV3Schema.safeParse(sampleEnvelope);
      expect(parsed.success).toBe(true);
    });

    it('should enforce pure SubBotLLMOutput without forcing telemetry or strikeCount', () => {
      const pureModelOutput = {
        outcome: 'COMPLETED',
        outputData: { codePatch: 'diff --git a/src/profile.ts' },
      };
      const parsed = SubBotLLMOutputSchema.safeParse(pureModelOutput);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.outcome).toBe('COMPLETED');
      }
    });

    it('should permit CONTRACT_CONFLICT outcome with evidence', () => {
      const conflictOutput = {
        outcome: 'CONTRACT_CONFLICT',
        conflictEvidence: 'Upstream spec mandates both snake_case and camelCase for user_id.',
      };
      const parsed = SubBotLLMOutputSchema.safeParse(conflictOutput);
      expect(parsed.success).toBe(true);
    });
  });

  describe('2. PromptSerializer & L1 Cache Breakpoint Stability', () => {
    it('guarantees identical L0 and L1 byte-for-byte prefixes for sibling tasks under the same parent', () => {
      const siblingEnvelope: BotTaskEnvelopeV3 = {
        ...sampleEnvelope,
        subtaskId: 'subtask-b', // Different subtask
        attempt: 2,             // Different attempt
        goal: 'Implement avatar upload handler',
        context: {
          ...sampleEnvelope.context,
          upstreamSlices: { storageService: 's3' },
        },
      };

      const serializerOpts = {
        staticRoleDefinition: 'You are the Senior Software Engineer Bot.',
        frozenMasterContextSnapshot: 'User Management Microservice Overhaul v1.0',
        blackboardReadIndex: [
          { id: 'ART-01', title: 'User Schema', summary: 'Database schema for users' },
        ],
      };

      const prompt1 = PromptSerializer.serialize(sampleEnvelope, serializerOpts);
      const prompt2 = PromptSerializer.serialize(siblingEnvelope, serializerOpts);

      // Sibling tasks MUST have 100% byte-for-byte identical L0 and L1 prefixes
      expect(prompt1.l0).toBe(prompt2.l0);
      expect(prompt1.l1).toBe(prompt2.l1);
      expect(prompt1.prefixHash).toBe(prompt2.prefixHash);

      // Only L2 differs
      expect(prompt1.l2).not.toBe(prompt2.l2);
    });

    it('strips pure runtime metadata (version, idempotencyKey, limits) from prompt', () => {
      const prompt = PromptSerializer.serialize(sampleEnvelope, {
        staticRoleDefinition: 'Engineer Bot',
      });

      expect(prompt.fullPrompt).not.toContain('expectedBlackboardVersion');
      expect(prompt.fullPrompt).not.toContain('idempotencyKey');
      expect(prompt.fullPrompt).not.toContain('maxExecutionTokens');
      expect(prompt.fullPrompt).not.toContain('subtask-a:attempt-1');
    });

    it('sanitizes artifact pointers in L2: exposes id/summary/lineRange, hides raw 64-char sha256 & uri', () => {
      const prompt = PromptSerializer.serialize(sampleEnvelope, {
        staticRoleDefinition: 'Engineer Bot',
      });

      expect(prompt.l2).toContain('ART-01');
      expect(prompt.l2).toContain('Database user schema definition');
      expect(prompt.l2).toContain('L10-L45');
      // Must NOT expose raw 64-char sha256 or uri to avoid model transcription errors
      expect(prompt.l2).not.toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(prompt.l2).not.toContain('file:///workspace/models/user.ts');
    });
  });

  describe('3. Runtime Harness: State Machine, Stale Pointers, Circuit Breaker & Telemetry', () => {
    it('successfully produces verified BotHandoffDeltaV3 on clean execution', () => {
      const delta = RuntimeHarness.processHandoff({
        envelope: sampleEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: {
          outcome: 'COMPLETED',
          outputData: { status: 'ok' },
        },
        durationMs: 3200,
        inputTokens: 10000,
        cachedInputTokens: 8200, // 82% cache hit
        outputTokens: 450,
        diffStats: {
          filesChanged: 3,
          insertions: 120,
          deletions: 15,
        },
      });

      expect(delta.status).toBe('SUCCESS');
      expect(delta.strikeCount).toBe(0);
      expect(delta.telemetry.cacheHitRate).toBe(0.82);
      expect(delta.engineeringStats?.diffBudgetExceeded).toBe(false);
    });

    it('flags diffBudgetExceeded soft warning when insertions+deletions exceed limit without failing', () => {
      const delta = RuntimeHarness.processHandoff({
        envelope: sampleEnvelope, // softDiffWarningLines: 400
        currentStrikeCount: 0,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 2000,
        inputTokens: 5000,
        cachedInputTokens: 4000,
        outputTokens: 200,
        diffStats: {
          filesChanged: 8,
          insertions: 350,
          deletions: 100, // Total = 450 > 400
        },
      });

      expect(delta.status).toBe('SUCCESS');
      expect(delta.engineeringStats?.diffBudgetExceeded).toBe(true);
    });

    it('detects stale artifact pointer and returns STALE_POINTER without burning strikes', () => {
      const mockResolver = {
        resolve: (_uri: string) => ({
          exists: true,
          sha256: 'mismatched-hash-value-00000000000000000000000000000000000000000000',
        }),
      };

      const delta = RuntimeHarness.processHandoff({
        envelope: sampleEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 500,
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 50,
        artifactResolver: mockResolver,
      });

      expect(delta.status).toBe('STALE_POINTER');
      expect(delta.strikeCount).toBe(0); // Zero penalty!
    });

    it('enforces two-strike circuit breaker: Strike 1 -> NEED_RETRY, Strike 2 -> CIRCUIT_BROKEN', () => {
      // First failure (Strike 1)
      const delta1 = RuntimeHarness.processHandoff({
        envelope: sampleEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 1500,
        inputTokens: 2000,
        cachedInputTokens: 1600,
        outputTokens: 100,
        verificationFn: () => ({
          passed: false,
          verifierType: 'CODE_TEST',
          summary: 'Unit test failed: email validator rejected valid format.',
          errorSnippet: 'Expected true but received false at line 42',
        }),
      });

      expect(delta1.status).toBe('NEED_RETRY');
      expect(delta1.strikeCount).toBe(1);

      // Second failure (Strike 2) - Circuit Broken!
      const delta2 = RuntimeHarness.processHandoff({
        envelope: { ...sampleEnvelope, attempt: 2 },
        currentStrikeCount: 1,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 1800,
        inputTokens: 2500,
        cachedInputTokens: 2000,
        outputTokens: 120,
        verificationFn: () => ({
          passed: false,
          verifierType: 'CODE_TEST',
          summary: 'Unit test failed again.',
        }),
      });

      expect(delta2.status).toBe('CIRCUIT_BROKEN');
      expect(delta2.strikeCount).toBe(2);
    });

    it('handles CONTRACT_CONFLICT cleanly without penalizing strike count', () => {
      const delta = RuntimeHarness.processHandoff({
        envelope: sampleEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: {
          outcome: 'CONTRACT_CONFLICT',
          conflictEvidence: 'Field email is declared both required and optional across specs.',
        },
        durationMs: 1100,
        inputTokens: 3000,
        cachedInputTokens: 2400,
        outputTokens: 90,
      });

      expect(delta.status).toBe('CONTRACT_CONFLICT');
      expect(delta.strikeCount).toBe(0);
      expect(delta.diagnostics?.conflictEvidence).toContain('Field email is declared both required');
    });
  });

  describe('4. Intra-Bot Subagent Manager (v3.1)', () => {
    const scoutEnvelope: IntraBotSubagentEnvelope = {
      ...sampleEnvelope,
      subtaskId: 'scout-subtask-1',
      invocationScope: 'INTRA_SUBAGENT',
      maxDepth: 1,
      isolationPolicy: {
        role: 'SCOUT',
        allowFileWriteTools: false,
      },
    };

    it('validates scout subagent envelope and rejects write tools', () => {
      const parsed = IntraBotSubagentManager.validateEnvelope(scoutEnvelope);
      expect(parsed.maxDepth).toBe(1);
      expect(parsed.isolationPolicy.role).toBe('SCOUT');
      if (parsed.isolationPolicy.role === 'SCOUT') {
        expect(parsed.isolationPolicy.allowFileWriteTools).toBe(false);
      }
    });

    it('enforces command allowlist and rejects shell operators, flags, and prefix cheating for VERIFIER', () => {
      const allowed = ['pnpm test', 'pnpm tsc', 'pnpm vitest'];

      // Valid clean command
      const res1 = IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test auth', allowed);
      expect(res1.allowed).toBe(true);

      // Forbidden shell chaining
      const res2 = IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test && rm -rf /', allowed);
      expect(res2.allowed).toBe(false);
      expect(res2.reason).toContain('forbidden shell operator');

      // Additional dangerous operators: &, newline, semicolon, variable interpolation
      expect(IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test & background', allowed).allowed).toBe(false);
      expect(IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test\nmalicious', allowed).allowed).toBe(false);
      expect(IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test; rm -rf', allowed).allowed).toBe(false);
      expect(IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test ${ENV_VAR}', allowed).allowed).toBe(false);

      // Forbidden flags: -u, --watch, etc.
      const resFlag1 = IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test -u', allowed);
      expect(resFlag1.allowed).toBe(false);
      expect(resFlag1.reason).toContain("forbidden flag '-u'");

      const resFlag2 = IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm vitest --watch', allowed);
      expect(resFlag2.allowed).toBe(false);
      expect(resFlag2.reason).toContain("forbidden flag '--watch'");

      // Prefix boundary check (prevents prefix stickiness / cheating)
      const resPrefix = IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test-all', allowed);
      expect(resPrefix.allowed).toBe(false);
      expect(resPrefix.reason).toContain('does not match any allowed command prefix');

      // Unlisted command
      const res3 = IntraBotSubagentManager.isCommandAllowedForVerifier('curl https://evil.com', allowed);
      expect(res3.allowed).toBe(false);
      expect(res3.reason).toContain('does not match any allowed command prefix');
    });

    it('enforces directory prefix and protects shared root files for BUILDER', () => {
      const allowedPrefixes = ['C:/project/src/auth'];
      const forbiddenSharedFiles = ['package.json', 'src/index.ts'];

      // Forbidden shared file
      const res1 = IntraBotSubagentManager.isPathAllowedForBuilder(
        'C:/project/package.json',
        allowedPrefixes,
        forbiddenSharedFiles
      );
      expect(res1.allowed).toBe(false);

      // Allowed isolated file
      const res2 = IntraBotSubagentManager.isPathAllowedForBuilder(
        'C:/project/src/auth/token.ts',
        allowedPrefixes,
        forbiddenSharedFiles
      );
      expect(res2.allowed).toBe(true);
    });

    it('correctly handles non-existent file inside existing ancestor directory for BUILDER', () => {
      const allowedDir = path.resolve('server/orchestration');
      const nonExistentFile = path.join(allowedDir, 'nested', 'brand-new-file.ts');
      const forbiddenSharedFiles = ['package.json', 'src/index.ts'];

      // Target path under allowedDir should be allowed even if file/nested dir does not exist yet
      const res = IntraBotSubagentManager.isPathAllowedForBuilder(
        nonExistentFile,
        [allowedDir],
        forbiddenSharedFiles
      );
      expect(res.allowed).toBe(true);
    });

    it('prevents partial match on forbidden files like subpackage.json vs package.json', () => {
      const allowedDir = path.resolve('server/orchestration');
      const subpackageFile = path.join(allowedDir, 'subpackage.json');
      const forbiddenSharedFiles = ['package.json'];

      // subpackage.json should NOT be blocked by package.json
      const res = IntraBotSubagentManager.isPathAllowedForBuilder(
        subpackageFile,
        [allowedDir],
        forbiddenSharedFiles
      );
      expect(res.allowed).toBe(true);
    });

    it('groups subagent batch by (modelId + prefixHash) for staggered cache warmup', () => {
      const batchRequest: IntraBotBatchRequest = {
        concurrencySlotLimit: 4,
        cacheWarmup: { enabled: true, waitForFirstTokenMsCap: 2500 },
        tasks: [
          scoutEnvelope,
          { ...scoutEnvelope, subtaskId: 'scout-subtask-2' },
          { ...scoutEnvelope, subtaskId: 'scout-subtask-3' },
        ],
      };

      const groups = IntraBotSubagentManager.groupBatchByPrefix(batchRequest, () => ({
        modelId: 'gemini-2.5-flash',
        prefixHash: 'shared-prefix-hash-abc',
      }));

      expect(groups.length).toBe(1);
      expect(groups[0].tasks.length).toBe(3);
      expect(groups[0].prefixKey).toBe('gemini-2.5-flash::shared-prefix-hash-abc');
    });

    it('waitForWarmupGate resolves TTFT_RESOLVED when pioneer resolves in time', async () => {
      const pioneerPromise = new Promise((resolve) => setTimeout(() => resolve('token-1'), 20));
      const result = await IntraBotSubagentManager.waitForWarmupGate(pioneerPromise, 500);
      expect(result.warmedUp).toBe(true);
      expect(result.reason).toBe('TTFT_RESOLVED');
    });

    it('waitForWarmupGate fails open with ERROR_FAIL_OPEN when pioneer rejects', async () => {
      const pioneerPromise = Promise.reject(new Error('Model quota exceeded'));
      const result = await IntraBotSubagentManager.waitForWarmupGate(pioneerPromise, 500);
      expect(result.warmedUp).toBe(false);
      expect(result.reason).toBe('ERROR_FAIL_OPEN');
    });

    it('waitForWarmupGate fails open with TIMEOUT_FAIL_OPEN when pioneer times out', async () => {
      const pioneerPromise = new Promise((resolve) => setTimeout(() => resolve('token-late'), 500));
      const result = await IntraBotSubagentManager.waitForWarmupGate(pioneerPromise, 30);
      expect(result.warmedUp).toBe(false);
      expect(result.reason).toBe('TIMEOUT_FAIL_OPEN');
    });
  });
});
