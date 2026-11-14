// Evaluation limits, the deadline that stops a script, and the result-size
// error follow T3 Code's apps/server/src/preview/ServerBrowserPage.ts,
// Copyright 2026 T3 Tools Inc., used under the MIT License
// (third_party/t3-code/LICENSE).

import type { CdpSession } from "./connection.ts";
import { DriverError, isGone } from "./errors.ts";
import type { FrameTree } from "./frames.ts";
import type { NodeHandle } from "./refs.ts";

export const MAX_EXPRESSION_CHARS = 64_000;
export const MAX_RESULT_BYTES = 64_000;
export const DEFAULT_EVALUATE_TIMEOUT_MS = 15_000;

export type World = "isolated" | "page";

/** A stopped script's call is left to settle this long before the connection gives up on its answer. */
const SETTLE_MS = 5_000;

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

interface EvaluationResult {
  result: RemoteObject;
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

const exceptionText = (details: NonNullable<EvaluationResult["exceptionDetails"]>) =>
  (details.exception?.description ?? details.text ?? "The script threw.").split("\n")[0]!;

function valueOf(result: RemoteObject): unknown {
  if ("value" in result) return result.value;
  if (result.unserializableValue !== undefined) return result.unserializableValue;
  return result.type === "undefined" ? undefined : result.description ?? null;
}

function checkSize(value: unknown): unknown {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
  if (bytes > MAX_RESULT_BYTES) {
    throw new DriverError("result-too-large", `Evaluation result is ${bytes} bytes; the limit is ${MAX_RESULT_BYTES}.`, { maximumBytes: MAX_RESULT_BYTES });
  }
  return value;
}

/** Past the deadline the script is terminated, so the tab answers the next request. */
async function withDeadline<T>(session: CdpSession, work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void session.send("Runtime.terminateExecution").catch(() => {});
      reject(new DriverError("timeout", `Evaluation did not finish within ${timeoutMs}ms and was stopped.`));
    }, timeoutMs);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface EvaluateOptions {
  world?: World;
  frameId?: string;
  timeoutMs?: number;
  awaitPromise?: boolean;
}

/** An agent's expression. The isolated world sees the DOM but not page globals; the page world is observable by page scripts. */
export async function evaluate(frames: FrameTree, expression: string, options: EvaluateOptions = {}): Promise<unknown> {
  if (expression.length > MAX_EXPRESSION_CHARS) {
    throw new DriverError("refused", `The expression is ${expression.length} characters; the limit is ${MAX_EXPRESSION_CHARS}.`);
  }
  const { world = "isolated", frameId = frames.mainFrameId, timeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS, awaitPromise = true } = options;
  const frame = frames.get(frameId);
  if (!frame) throw new DriverError("not-found", "That frame is gone.");
  const result = world === "isolated"
    ? await frames.inWorld(frameId, (session, contextId) =>
      withDeadline(session, session.send<EvaluationResult>("Runtime.evaluate", { expression, contextId, awaitPromise, returnByValue: true }, { timeoutMs: timeoutMs + SETTLE_MS }), timeoutMs))
    : await evaluateInPageWorld(frames, frameId, expression, awaitPromise, timeoutMs);
  if (result.exceptionDetails) throw new DriverError("execution", exceptionText(result.exceptionDetails));
  return checkSize(valueOf(result.result));
}

async function evaluateInPageWorld(frames: FrameTree, frameId: string, expression: string, awaitPromise: boolean, timeoutMs: number): Promise<EvaluationResult> {
  const frame = frames.get(frameId)!;
  const session = frame.session;
  if (frames.rootOf(session) === frameId) {
    return withDeadline(session, session.send<EvaluationResult>("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, { timeoutMs: timeoutMs + SETTLE_MS, pageWorld: true }), timeoutMs);
  }
  // A frame that shares its renderer with its parent: run in that document's own world through the node itself.
  const documentId = await frames.inWorld(frameId, async (worldSession, contextId) => {
    const found = await worldSession.send<EvaluationResult>("Runtime.evaluate", { expression: "document", contextId, returnByValue: false });
    const objectId = found.result.objectId;
    if (!objectId) throw new DriverError("not-found", "That frame has no document.");
    const { node } = await worldSession.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId });
    void worldSession.send("Runtime.releaseObject", { objectId }).catch(() => {});
    return node.backendNodeId;
  });
  const { object } = await session.send<{ object: RemoteObject }>("DOM.resolveNode", { backendNodeId: documentId });
  if (!object.objectId) throw new DriverError("not-found", "That frame has no document.");
  try {
    return await withDeadline(session, session.send<EvaluationResult>("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function (source) { return (0, eval)(source); }",
      arguments: [{ value: expression }],
      awaitPromise,
      returnByValue: true,
    }, { timeoutMs: timeoutMs + SETTLE_MS }), timeoutMs);
  } finally {
    void session.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  }
}

/** Calls `fn` (source text) with the node as `this`, in the isolated world of the node's frame. */
export async function callOnNode<T>(
  frames: FrameTree,
  handle: NodeHandle,
  fn: string,
  args: readonly unknown[] = [],
  { awaitPromise = false }: { awaitPromise?: boolean } = {},
): Promise<T> {
  return frames.inWorld(handle.frameId, async (session, contextId) => {
    const objectId = await resolveInWorld(session, handle.backendNodeId, contextId);
    try {
      const result = await session.send<EvaluationResult>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise,
      });
      if (result.exceptionDetails) throw new DriverError("execution", exceptionText(result.exceptionDetails));
      return valueOf(result.result) as T;
    } finally {
      void session.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  });
}

export async function resolveInWorld(session: CdpSession, backendNodeId: number, contextId: number, objectGroup?: string): Promise<string> {
  try {
    const { object } = await session.send<{ object: RemoteObject }>("DOM.resolveNode", { backendNodeId, executionContextId: contextId, ...(objectGroup ? { objectGroup } : {}) });
    if (!object.objectId) throw new DriverError("not-found", "The element is gone.");
    return object.objectId;
  } catch (error) {
    if (isGone(error)) throw new DriverError("not-found", "The element is gone.");
    throw error;
  }
}

/** Runs a function in a frame's isolated world and keeps the result as a remote object (for nodes). */
export async function callInWorld(frames: FrameTree, frameId: string, fn: string, args: readonly unknown[] = []): Promise<{ session: CdpSession; result: RemoteObject }> {
  return frames.inWorld(frameId, async (session, contextId) => {
    const found = await session.send<EvaluationResult>("Runtime.evaluate", { expression: "document", contextId, returnByValue: false });
    const documentId = found.result.objectId;
    if (!documentId) throw new DriverError("not-found", "The frame has no document.");
    try {
      const result = await session.send<EvaluationResult>("Runtime.callFunctionOn", {
        objectId: documentId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: false,
      });
      if (result.exceptionDetails) throw new DriverError("execution", exceptionText(result.exceptionDetails));
      return { session, result: result.result };
    } finally {
      void session.send("Runtime.releaseObject", { objectId: documentId }).catch(() => {});
    }
  });
}

/** A plain value computed in a frame's isolated world. */
export async function valueInWorld<T>(frames: FrameTree, frameId: string, expression: string, { awaitPromise = false } = {}): Promise<T> {
  const result = await frames.inWorld(frameId, (session, contextId) =>
    session.send<EvaluationResult>("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise }));
  if (result.exceptionDetails) throw new DriverError("execution", exceptionText(result.exceptionDetails));
  return valueOf(result.result) as T;
}
