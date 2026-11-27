import { describe, expect, it, vi } from "vitest";

import { createLinkCommandsFact } from "./link-commands-fact.mjs";

function harness() {
  const posted = [];
  const f = { proc: { postMessage: (message) => posted.push(message) }, posted };
  f.fact = createLinkCommandsFact({ server: () => f.proc, log: vi.fn() });
  return f;
}

describe("the commands grant as the local server hears it", () => {
  it("is on only while Clouds may run commands here and lending is not paused", () => {
    const f = harness();
    f.fact.observe({ terminal: true, paused: false });
    f.fact.observe({ terminal: true, paused: true });
    f.fact.observe({ terminal: false, paused: false });
    f.fact.observe(null);
    expect(f.posted).toEqual([
      { type: "openmausbot:link-commands", on: true },
      { type: "openmausbot:link-commands", on: false },
    ]);
  });

  it("tells a server that (re)started, and nothing while there is none", () => {
    const f = harness();
    f.proc = null;
    f.fact.observe({ terminal: true, paused: false });
    expect(f.posted).toEqual([]);
    f.proc = { postMessage: (message) => f.posted.push(message) };
    f.fact.serverStarted();
    f.fact.serverStarted();
    expect(f.posted).toEqual([{ type: "openmausbot:link-commands", on: true }, { type: "openmausbot:link-commands", on: true }]);
  });
});
