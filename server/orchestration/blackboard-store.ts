import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ArtifactPointer, BotHandoffDeltaV3 } from './contracts.ts';
import type { ArtifactResolver } from './harness.ts';

export interface BlackboardState {
  version: number;
  parentTaskId: string;
  artifacts: Record<string, ArtifactPointer>;
  deltas: BotHandoffDeltaV3[];
  updatedAt: string;
}

export interface WriteDraftArtifactParams {
  parentTaskId: string;
  subtaskId: string;
  attempt: number;
  filename: string;
  content: string | Buffer;
  summary?: string;
  id?: string;
  lineRange?: string;
}

export interface ReadArtifactResult {
  content: string;
  sha256: string;
  pointer: ArtifactPointer;
}

export interface BlackboardStoreOptions {
  baseDir: string;
}

export class BlackboardStore implements ArtifactResolver {
  public readonly baseDir: string;

  constructor(options: BlackboardStoreOptions) {
    this.baseDir = path.resolve(options.baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * Path to blackboard JSON file for a given parent task.
   */
  public getBlackboardFilePath(parentTaskId: string): string {
    const safeParent = this.sanitizePathSegment(parentTaskId);
    const parentDir = path.join(this.baseDir, safeParent);
    fs.mkdirSync(parentDir, { recursive: true });
    return path.join(parentDir, 'blackboard.json');
  }

  /**
   * Load blackboard state from disk.
   */
  public async loadBlackboard(parentTaskId: string): Promise<BlackboardState> {
    const filePath = this.getBlackboardFilePath(parentTaskId);
    if (!fs.existsSync(filePath)) {
      return {
        version: 0,
        parentTaskId,
        artifacts: {},
        deltas: [],
        updatedAt: new Date().toISOString(),
      };
    }
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as BlackboardState;
  }

  /**
   * Save blackboard state atomically to disk.
   */
  public async saveBlackboard(parentTaskId: string, state: BlackboardState): Promise<void> {
    const filePath = this.getBlackboardFilePath(parentTaskId);
    state.updatedAt = new Date().toISOString();
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await fs.promises.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.promises.rename(tempPath, filePath);
  }

  /**
   * Write an artifact into the isolated draft directory:
   * drafts/<parent>/<subtask>/attempt-<n>/<filename>
   */
  public async writeDraftArtifact(params: WriteDraftArtifactParams): Promise<ArtifactPointer> {
    const safeParent = this.sanitizePathSegment(params.parentTaskId);
    const safeSubtask = this.sanitizePathSegment(params.subtaskId);
    const safeAttempt = `attempt-${params.attempt}`;
    const safeFilename = path.basename(params.filename);

    const draftDir = path.join(this.baseDir, 'drafts', safeParent, safeSubtask, safeAttempt);
    await fs.promises.mkdir(draftDir, { recursive: true });

    const targetFilePath = path.join(draftDir, safeFilename);
    const buffer = typeof params.content === 'string' ? Buffer.from(params.content, 'utf8') : params.content;
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    await fs.promises.writeFile(targetFilePath, buffer);

    const artifactId = params.id ?? `ART-${params.subtaskId}-${safeFilename}`;
    const pointer: ArtifactPointer = {
      id: artifactId,
      summary: params.summary ?? `Artifact ${safeFilename} for ${params.subtaskId}`,
      uri: targetFilePath,
      sha256,
      lineRange: params.lineRange,
    };

    // Automatically update blackboard state
    const state = await this.loadBlackboard(params.parentTaskId);
    state.artifacts[artifactId] = pointer;
    state.version += 1;
    await this.saveBlackboard(params.parentTaskId, state);

    return pointer;
  }

  /**
   * Read artifact by ID, ensuring disk file exists and its SHA-256 hash strictly matches.
   * Throws if tampered or missing.
   */
  public async read_artifact(params: { id: string; parentTaskId?: string }): Promise<ReadArtifactResult> {
    const { id, parentTaskId } = params;
    let pointer: ArtifactPointer | undefined;

    if (parentTaskId) {
      const state = await this.loadBlackboard(parentTaskId);
      pointer = state.artifacts[id];
    } else {
      pointer = await this.findArtifactPointer(id);
    }

    if (!pointer) {
      throw new Error(`Artifact with ID '${id}' not found in blackboard index.`);
    }

    if (!fs.existsSync(pointer.uri)) {
      throw new Error(`Artifact file at '${pointer.uri}' does not exist on disk.`);
    }

    const fileBuffer = await fs.promises.readFile(pointer.uri);
    const currentSha256 = createHash('sha256').update(fileBuffer).digest('hex');

    if (currentSha256 !== pointer.sha256) {
      throw new Error(
        `Security integrity error: Artifact '${id}' SHA-256 mismatch! Expected ${pointer.sha256}, got ${currentSha256}. Possible tampering detected.`
      );
    }

    return {
      content: fileBuffer.toString('utf8'),
      sha256: currentSha256,
      pointer,
    };
  }

  /**
   * Record handoff delta and bump blackboard version.
   */
  public async appendDelta(parentTaskId: string, delta: BotHandoffDeltaV3): Promise<void> {
    const state = await this.loadBlackboard(parentTaskId);
    state.deltas.push(delta);
    state.version += 1;
    await this.saveBlackboard(parentTaskId, state);
  }

  /**
   * Implements ArtifactResolver for RuntimeHarness.checkArtifactPointers
   */
  public resolve(uri: string): { exists: boolean; sha256?: string; content?: string } {
    try {
      if (!fs.existsSync(uri)) {
        return { exists: false };
      }
      const buffer = fs.readFileSync(uri);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      return {
        exists: true,
        sha256,
        content: buffer.toString('utf8'),
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Get read-only index summary formatted for PromptSerializer.
   */
  public async getIndexForPrompt(parentTaskId: string): Promise<Array<{ id: string; title: string; summary: string }>> {
    const state = await this.loadBlackboard(parentTaskId);
    return Object.values(state.artifacts).map((p) => ({
      id: p.id,
      title: path.basename(p.uri),
      summary: p.summary,
    }));
  }

  private async findArtifactPointer(id: string): Promise<ArtifactPointer | undefined> {
    const entries = await fs.promises.readdir(this.baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'drafts') {
        const boardFile = path.join(this.baseDir, entry.name, 'blackboard.json');
        if (fs.existsSync(boardFile)) {
          const raw = await fs.promises.readFile(boardFile, 'utf8');
          const state = JSON.parse(raw) as BlackboardState;
          if (state.artifacts && state.artifacts[id]) {
            return state.artifacts[id];
          }
        }
      }
    }
    return undefined;
  }

  private sanitizePathSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
}
