import type { AcpSession } from "./turn-state.ts";

import { captureCliTree, killCliTree } from "../../procs.ts";

export async function confirmAcpTermination(session: AcpSession, close: () => Promise<boolean>, failed: () => void, closeTimeoutMs?: number): Promise<boolean> {
  const { child, host } = session;
  captureCliTree(child);
  let onExit!: () => void;
  const exited = new Promise<false>((resolve) => {
    onExit = () => resolve(false);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    else child.once("exit", onExit);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmed = false;
  let confirmation: Promise<boolean>;
  try {
    confirmation = close().then(value => { confirmed = value; return value; });
    if (await Promise.race([confirmation, exited, new Promise<false>((resolve) => {
      if (closeTimeoutMs !== undefined) timer = setTimeout(() => resolve(false), closeTimeoutMs);
    })])) return true;
  } finally {
    clearTimeout(timer);
    child.removeListener("exit", onExit);
  }
  const closed = confirmation.then(value => value ? true : new Promise<never>(() => {}));
  host.draining = true;
  let reported = false;
  while (!confirmed && !await Promise.race([closed, killCliTree(child, closeTimeoutMs === undefined ? undefined : 2_000).catch(() => false)])) {
    if (!reported) { reported = true; failed(); }
    // Keep ownership until session closure or confirmed tree termination.
    try {
      await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); timer.unref?.(); })]);
    } finally {
      clearTimeout(timer);
    }
  }
  return confirmed || !reported;
}

export async function awaitAcpTeardown(pending: Promise<unknown>[], failed: () => Error): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(pending),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failed()), 10_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
