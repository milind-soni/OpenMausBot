// Each agent-browser session's egress gate is a loopback listener of its own (gate.ts). A bot's browser that has ended
// (closed for sitting unused, restarted, or never reopened after a server restart) needs none until it opens again.

export interface EndedGateChecks {
  /** Sessions with an open gate, as a copy: a release changes the set. */
  sessions(): Iterable<string>;
  /** The session's agent-browser launch environment, or null when it is not an agent-browser session of this server. */
  env(session: string): NodeJS.ProcessEnv | null;
  /** Whether agent-browser runs the session's daemon (its pid file exists). */
  running(session: string, env: NodeJS.ProcessEnv): boolean;
  /** A turn holds the browser, or a call or a person is using it. */
  inUse(session: string): boolean;
  release(session: string): Promise<void>;
}

/** Releases the gate of every session whose browser no longer runs and that nothing uses; resolves to those released. */
export async function releaseEndedGates(checks: EndedGateChecks): Promise<string[]> {
  const released: string[] = [];
  for (const session of checks.sessions()) {
    const env = checks.env(session);
    if (!env || checks.inUse(session) || checks.running(session, env)) continue;
    await checks.release(session).catch(() => undefined);
    released.push(session);
  }
  return released;
}
