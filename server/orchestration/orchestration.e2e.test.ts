import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  type BotTaskEnvelopeV3,
  type IntraBotSubagentEnvelope,
  BlackboardStore,
  VerifierRunner,
  ToolFilter,
  PromptSerializer,
  RuntimeHarness,
} from './index.ts';

describe('Server Orchestration P0 End-to-End & Integration Suite', () => {
  let tempDir: string;
  let blackboardStore: BlackboardStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-e2e-test-'));
    blackboardStore = new BlackboardStore({ baseDir: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('BlackboardStore & Artifact Storage', () => {
    it('persists draft artifact in isolated directory and reads back with SHA-256 integrity check', async () => {
      const artifact = await blackboardStore.writeDraftArtifact({
        parentTaskId: 'TASK-PARENT-E2E',
        subtaskId: 'subtask-data',
        attempt: 1,
        filename: 'data.json',
        content: JSON.stringify({ status: 'ok', count: 42 }),
        summary: 'Processed dataset for subtask-data',
      });

      expect(artifact.id).toBe('ART-subtask-data-data.json');
      expect(artifact.uri).toContain(path.join('drafts', 'TASK-PARENT-E2E', 'subtask-data', 'attempt-1', 'data.json'));
      expect(artifact.sha256).toHaveLength(64);
      expect(fs.existsSync(artifact.uri)).toBe(true);

      // Read back with read_artifact
      const readResult = await blackboardStore.read_artifact({ id: artifact.id });
      expect(readResult.sha256).toBe(artifact.sha256);
      expect(JSON.parse(readResult.content)).toEqual({ status: 'ok', count: 42 });

      // Verify resolver
      const resolved = blackboardStore.resolve(artifact.uri);
      expect(resolved.exists).toBe(true);
      expect(resolved.sha256).toBe(artifact.sha256);
    });

    it('detects tampering and throws error if disk artifact was modified after registration', async () => {
      const artifact = await blackboardStore.writeDraftArtifact({
        parentTaskId: 'TASK-PARENT-TAMPER',
        subtaskId: 'subtask-sec',
        attempt: 1,
        filename: 'report.txt',
        content: 'Original Untampered Content',
      });

      // Tamper with the disk file
      fs.writeFileSync(artifact.uri, 'Malicious Modified Content', 'utf8');

      // Attempting to read should throw integrity error
      await expect(blackboardStore.read_artifact({ id: artifact.id })).rejects.toThrow(
        /Security integrity error: Artifact '.*' SHA-256 mismatch/
      );
    });

    it('tracks blackboard state versions and appends deltas cleanly', async () => {
      const parentTaskId = 'TASK-VERSIONING';
      const initial = await blackboardStore.loadBlackboard(parentTaskId);
      expect(initial.version).toBe(0);

      await blackboardStore.writeDraftArtifact({
        parentTaskId,
        subtaskId: 'st-1',
        attempt: 1,
        filename: 'sample.txt',
        content: 'hello',
      });

      const afterWrite = await blackboardStore.loadBlackboard(parentTaskId);
      expect(afterWrite.version).toBe(1);

      await blackboardStore.appendDelta(parentTaskId, {
        subtaskId: 'st-1',
        idempotencyKey: 'st-1:attempt-1',
        status: 'SUCCESS',
        strikeCount: 0,
        verification: {
          passed: true,
          verifierType: 'CODE_TEST',
          summary: 'All checks passed',
        },
        telemetry: {
          durationMs: 120,
          inputTokens: 500,
          cachedInputTokens: 400,
          outputTokens: 80,
          cacheHitRate: 0.8,
        },
      });

      const afterDelta = await blackboardStore.loadBlackboard(parentTaskId);
      expect(afterDelta.version).toBe(2);
      expect(afterDelta.deltas).toHaveLength(1);
      expect(afterDelta.deltas[0].status).toBe('SUCCESS');
    });
  });

  describe('VerifierRunner Hard Security & Sandboxing', () => {
    it('executes permitted commands safely with { shell: false } and injects isolated environment', async () => {
      const allowedPrefixes = ['node -e'];
      const script = "console.log(JSON.stringify({ port: process.env.PORT, ci: process.env.CI, hasTmp: Boolean(process.env.TMPDIR ?? process.env.TEMP) }))";
      const cmd = `node -e "${script}"`;

      const result = await VerifierRunner.runCommand(cmd, allowedPrefixes);
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.port).toBe('0');
      expect(parsed.ci).toBe('1');
      expect(parsed.hasTmp).toBe(true);
    });

    it('blocks dangerous shell operators and snapshot mutation / watch flags', async () => {
      const allowedPrefixes = ['pnpm test', 'vitest run'];

      // Operator injection
      const chained = await VerifierRunner.runCommand('pnpm test && rm -rf /', allowedPrefixes);
      expect(chained.passed).toBe(false);
      expect(chained.errorSnippet).toContain('forbidden shell operator');

      // Watch flag
      const watch = await VerifierRunner.runCommand('vitest run --watch', allowedPrefixes);
      expect(watch.passed).toBe(false);
      expect(watch.errorSnippet).toContain('forbidden flag');

      // Update snapshot flag
      const updateSnap = await VerifierRunner.runCommand('pnpm test -u', allowedPrefixes);
      expect(updateSnap.passed).toBe(false);
      expect(updateSnap.errorSnippet).toContain('forbidden flag');

      // Unauthorized prefix
      const unauth = await VerifierRunner.runCommand('cargo build', allowedPrefixes);
      expect(unauth.passed).toBe(false);
      expect(unauth.errorSnippet).toContain('does not match any allowed command prefix');
    });

    it('returns VerificationCheckResult properly when used as DoD check', async () => {
      const checkResult = await VerifierRunner.runAsVerificationCheck(
        'node -e "process.exit(0)"',
        ['node -e']
      );
      expect(checkResult.passed).toBe(true);
      expect(checkResult.verifierType).toBe('CODE_TEST');

      const failedCheck = await VerifierRunner.runAsVerificationCheck(
        'node -e "process.exit(2)"',
        ['node -e']
      );
      expect(failedCheck.passed).toBe(false);
      expect(failedCheck.verifierType).toBe('CODE_TEST');
      expect(failedCheck.summary).toContain('exit code 2');
    });

    it.runIf(process.platform === 'win32')('executes Windows .cmd shims cleanly and blocks cmd metacharacters', async () => {
      const shimDir = path.join(tempDir, 'win cmd shim');
      fs.mkdirSync(shimDir, { recursive: true });
      const shimPath = path.join(shimDir, 'check shim.cmd');
      fs.writeFileSync(shimPath, '@echo off\r\necho ARG=%~1\r\necho PORT=%PORT%\r\n');

      const okRes = await VerifierRunner.runCommand(`"${shimPath}" "hello world"`, [shimPath, `"${shimPath}"`]);
      expect(okRes.passed).toBe(true);
      expect(okRes.stdout).toContain('ARG=hello world');
      expect(okRes.stdout).toContain('PORT=0');

      const blockedRes = await VerifierRunner.runCommand(`"${shimPath}" %TEMP%`, [shimPath, `"${shimPath}"`]);
      expect(blockedRes.passed).toBe(false);
      expect(blockedRes.errorSnippet).toContain('unsafe cmd.exe metacharacters');
    });
  });

  describe('ToolFilter & Max Depth = 1 Enforcements', () => {
    function createEnvelopes(targetDir: string) {
      const scoutEnvelope: IntraBotSubagentEnvelope = {
        parentTaskId: 'TASK-TF-01',
        expectedBlackboardVersion: 1,
        idempotencyKey: 'scout-1:attempt-1',
        limits: { maxExecutionTokens: 8000, maxToolCalls: 10, timeoutMs: 30000 },
        subtaskId: 'scout-1',
        attempt: 1,
        tier: 'T1_FAST',
        goal: 'Explore target structure',
        executionProfile: { kind: 'GENERAL', draftNamespace: 'drafts/scout' },
        context: { upstreamSlices: {}, contractRules: [], forbiddenScope: [] },
        acceptanceCriteria: {
          outputSchemaName: 'ScoutOutput',
          verifierType: 'SCHEMA_RULE',
          checks: ['Verify JSON'],
        },
        invocationScope: 'INTRA_SUBAGENT',
        maxDepth: 1,
        isolationPolicy: {
          role: 'SCOUT',
          allowFileWriteTools: false,
        },
      };

      const builderEnvelope: IntraBotSubagentEnvelope = {
        ...scoutEnvelope,
        subtaskId: 'builder-1',
        isolationPolicy: {
          role: 'DISJOINT_BUILDER',
          allowedWritePrefixes: [path.join(targetDir, 'src', 'feature')],
          forbiddenSharedFiles: ['package.json', 'server/index.ts'],
        },
      };

      return { scoutEnvelope, builderEnvelope };
    }

    it('physically strips recursive spawn tools for all subagents (Max Depth = 1)', () => {
      const { scoutEnvelope, builderEnvelope } = createEnvelopes(tempDir);
      const allTools = [
        'view_file',
        'spawn_subagent',
        'invoke_subagent',
        'coordinate_bots',
        'client_create_file',
        'run_command',
      ];

      const scoutTools = ToolFilter.filterToolNamesForSubagent(allTools, scoutEnvelope);
      expect(scoutTools).not.toContain('spawn_subagent');
      expect(scoutTools).not.toContain('invoke_subagent');
      expect(scoutTools).not.toContain('coordinate_bots');
      expect(scoutTools).not.toContain('client_create_file');
      expect(scoutTools).toContain('view_file');
      expect(scoutTools).toContain('run_command');

      const builderTools = ToolFilter.filterToolNamesForSubagent(allTools, builderEnvelope);
      expect(builderTools).not.toContain('spawn_subagent');
      expect(builderTools).not.toContain('invoke_subagent');
      expect(builderTools).toContain('client_create_file');
      expect(builderTools).toContain('view_file');
    });

    it('blocks unauthorized file writes and forbidden shared files dynamically', () => {
      const { scoutEnvelope, builderEnvelope } = createEnvelopes(tempDir);

      // 1. Recursive spawn blocked
      expect(() =>
        ToolFilter.assertToolCallPermitted('spawn_subagent', {}, scoutEnvelope)
      ).toThrow(/Recursive subagent spawning is forbidden/);

      // 2. Scout writing file blocked
      expect(() =>
        ToolFilter.assertToolCallPermitted('client_create_file', { target_file: 'any.txt' }, scoutEnvelope)
      ).toThrow(/not authorized to call file write tool/);

      // 3. Builder writing forbidden shared file blocked
      expect(() =>
        ToolFilter.assertToolCallPermitted(
          'client_create_file',
          { target_file: path.join(tempDir, 'package.json') },
          builderEnvelope
        )
      ).toThrow(/Modification of shared root entry/);

      // 4. Builder writing outside allowed prefix blocked
      expect(() =>
        ToolFilter.assertToolCallPermitted(
          'client_create_file',
          { target_file: path.join(tempDir, 'other', 'leak.ts') },
          builderEnvelope
        )
      ).toThrow(/Target path .* is outside allowed write prefixes/);

      // 5. Builder writing within allowed prefix allowed
      const allowedFile = path.join(tempDir, 'src', 'feature', 'valid.ts');
      fs.mkdirSync(path.dirname(allowedFile), { recursive: true });
      expect(() =>
        ToolFilter.assertToolCallPermitted(
          'client_create_file',
          { target_file: allowedFile },
          builderEnvelope
        )
      ).not.toThrow();
    });
  });

  describe('Full Orchestration Loop: Store -> Serializer -> Verifier -> Harness', () => {
    it('executes full round-trip from draft creation to verified delta recording', async () => {
      const parentTaskId = 'TASK-E2E-LOOP';

      // 1. Write an artifact to blackboard
      const artifact = await blackboardStore.writeDraftArtifact({
        parentTaskId,
        subtaskId: 'sub-producer',
        attempt: 1,
        filename: 'schema.json',
        content: JSON.stringify({ greeting: 'hello' }),
        summary: 'Schema output from producer',
      });

      // 2. Build task envelope referencing artifact
      const envelope: BotTaskEnvelopeV3 = {
        parentTaskId,
        expectedBlackboardVersion: 1,
        idempotencyKey: 'sub-consumer:attempt-1',
        limits: { maxExecutionTokens: 16000, maxToolCalls: 15, timeoutMs: 30000 },
        subtaskId: 'sub-consumer',
        attempt: 1,
        tier: 'T2_STANDARD',
        goal: 'Consume schema and build client response',
        executionProfile: { kind: 'GENERAL', draftNamespace: 'drafts/consumer' },
        context: {
          upstreamSlices: { producerOutcome: 'READY' },
          contractRules: ['Must output valid greeting'],
          forbiddenScope: ['Do not edit server/index.ts'],
        },
        artifactPointers: [artifact],
        acceptanceCriteria: {
          outputSchemaName: 'GreetingOutput',
          verifierType: 'CODE_TEST',
          checks: ['Exit code must be 0'],
        },
      };

      // 3. Serialize prompt
      const serialized = PromptSerializer.serialize(envelope, {
        staticRoleDefinition: 'You are a client response generator.',
        blackboardReadIndex: await blackboardStore.getIndexForPrompt(parentTaskId),
      });

      expect(serialized.l0).toContain('OUTPUT CONTRACT REQUIREMENT');
      expect(serialized.l1).toContain(`Parent Task ID: ${parentTaskId}`);
      expect(serialized.l1).toContain(artifact.id);
      expect(serialized.l2).toContain('Subtask ID: sub-consumer');
      expect(serialized.fullPrompt).toContain(PromptSerializer.BREAKPOINT_L0_L1);
      expect(serialized.fullPrompt).toContain(PromptSerializer.BREAKPOINT_L1_L2);

      // 4. Run real verifier
      const verifierResult = await VerifierRunner.runAsVerificationCheck(
        'node -e "process.exit(0)"',
        ['node -e']
      );
      expect(verifierResult.passed).toBe(true);

      // 5. Process handoff in RuntimeHarness
      const delta = RuntimeHarness.processHandoff({
        envelope,
        currentStrikeCount: 0,
        rawLLMOutput: {
          outcome: 'COMPLETED',
          outputData: { message: 'Greeting received' },
        },
        durationMs: 450,
        inputTokens: 1200,
        cachedInputTokens: 950,
        outputTokens: 120,
        artifactResolver: blackboardStore,
        verificationFn: () => verifierResult,
      });

      expect(delta.status).toBe('SUCCESS');
      expect(delta.strikeCount).toBe(0);
      expect(delta.telemetry.cacheHitRate).toBeCloseTo(950 / 1200, 2);

      // 6. Record delta to blackboard
      await blackboardStore.appendDelta(parentTaskId, delta);
      const state = await blackboardStore.loadBlackboard(parentTaskId);
      expect(state.deltas).toHaveLength(1);
      expect(state.deltas[0].status).toBe('SUCCESS');
    });

    it('enforces two-strike circuit breaking when verifier repeatedly fails', async () => {
      const parentTaskId = 'TASK-E2E-STRIKE';
      const envelope: BotTaskEnvelopeV3 = {
        parentTaskId,
        expectedBlackboardVersion: 1,
        idempotencyKey: 'sub-failing:attempt-1',
        limits: { maxExecutionTokens: 8000, maxToolCalls: 5, timeoutMs: 15000 },
        subtaskId: 'sub-failing',
        attempt: 1,
        tier: 'T1_FAST',
        goal: 'Attempt risky change',
        executionProfile: { kind: 'GENERAL', draftNamespace: 'drafts/failing' },
        context: { upstreamSlices: {}, contractRules: [], forbiddenScope: [] },
        acceptanceCriteria: {
          outputSchemaName: 'RiskyOutput',
          verifierType: 'CODE_TEST',
          checks: ['Must pass test suite'],
        },
      };

      const failingCheck = await VerifierRunner.runAsVerificationCheck(
        'node -e "process.exit(1)"',
        ['node -e']
      );

      // Strike 1
      const delta1 = RuntimeHarness.processHandoff({
        envelope,
        currentStrikeCount: 0,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 300,
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 50,
        verificationFn: () => failingCheck,
      });

      expect(delta1.status).toBe('NEED_RETRY');
      expect(delta1.strikeCount).toBe(1);

      // Strike 2 -> Circuit Broken
      const delta2 = RuntimeHarness.processHandoff({
        envelope: { ...envelope, attempt: 2 },
        currentStrikeCount: 1,
        rawLLMOutput: { outcome: 'COMPLETED' },
        durationMs: 320,
        inputTokens: 1100,
        cachedInputTokens: 500,
        outputTokens: 60,
        verificationFn: () => failingCheck,
      });

      expect(delta2.status).toBe('CIRCUIT_BROKEN');
      expect(delta2.strikeCount).toBe(2);
    });
  });
});
