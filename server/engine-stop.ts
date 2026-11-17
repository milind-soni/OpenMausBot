import type { ChildProcess } from "node:child_process";
import { killCliTree, waitForExit } from "./procs.ts";

/** How long an engine gets to leave on its own after its input ends, and after SIGTERM, before it is killed. */
export const ENGINE_EOF_GRACE_MS = 500;
export const ENGINE_TERM_GRACE_MS = 1_500;

/** Ends an engine as a close does (end of its input), then stops whatever of its tree is left: the MCP servers and
 * tools it started lead no group of their own and stay behind otherwise. True once the whole tree is gone; at most
 * eofGraceMs + termGraceMs + 1 s. */
export async function stopEngineTree(child: ChildProcess, eofGraceMs = ENGINE_EOF_GRACE_MS, termGraceMs = ENGINE_TERM_GRACE_MS): Promise<boolean> {
  try { child.stdin?.end(); } catch {}
  if (eofGraceMs > 0) await waitForExit(child, eofGraceMs);
  return killCliTree(child, termGraceMs).catch(() => false);
}

/** Stops every distinct tree at once; resolves when all are confirmed gone or past their deadlines. */
export async function stopEngineTrees(children: Iterable<ChildProcess>, eofGraceMs?: number): Promise<boolean> {
  const results = await Promise.all([...new Set(children)].map((child) => stopEngineTree(child, eofGraceMs)));
  return results.every(Boolean);
}
