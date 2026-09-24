import type { Assertion } from "../types.ts";
import type { WorldSnapshot } from "./snapshot.ts";

/** Pure scorers: each assertion is evaluated against the world snapshot
 * the runner collected after the scenario steps finished. The snapshot is
 * frozen evidence; no scorer touches a server. */

export interface AssertionResult {
  assertion: Assertion;
  pass: boolean;
  detail: string;
}

const deepEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const fmt = (value: unknown): string => JSON.stringify(value, null, 2);

export function evaluateAssertions(assertions: Assertion[], world: WorldSnapshot): AssertionResult[] {
  return assertions.map((assertion) => {
    try {
      return { assertion, ...score(assertion, world) };
    } catch (error) {
      return { assertion, pass: false, detail: "scorer error: " + (error instanceof Error ? error.message : String(error)) };
    }
  });
}

function score(assertion: Assertion, world: WorldSnapshot): { pass: boolean; detail: string } {
  switch (assertion.kind) {
    case "sendNotQueued": {
      const receipts = world.sends.filter((send) => send.bot === assertion.bot);
      const queued = receipts.filter((send) => send.queued === true);
      return receipts.length === 0
        ? { pass: false, detail: "no sends were recorded for this bot" }
        : queued.length === 0
          ? { pass: true, detail: receipts.length + " send(s) all ran immediately" }
          : { pass: false, detail: "queued sends: " + fmt(queued) };
    }
    case "toolCalls": {
      const calls = world.turns
        .filter((turn) => turn.bot === assertion.bot)
        .flatMap((turn) => turn.toolCalls);
      const expected = assertion.equals.map((call) => ({
        tool: call.tool ?? "coordinate_bots",
        arguments: world.resolve(call.arguments),
        errored: call.expectError,
      }));
      // errored is only pinned when the fixture says expectError; otherwise
      // the comparison is on tool name and arguments alone.
      const mismatches = expected.flatMap((want, index) => {
        const got = calls[index];
        if (got === undefined) return ["missing call #" + (index + 1)];
        const sameTool = got.tool === want.tool;
        const sameArguments = deepEqual(got.arguments, want.arguments);
        const sameError = want.errored === undefined || got.errored === want.errored;
        return sameTool && sameArguments && sameError
          ? []
          : ["call #" + (index + 1) + " differs: expected " + fmt(want) + ", got " + fmt({ tool: got.tool, arguments: got.arguments, errored: got.errored })];
      });
      if (calls.length > expected.length) mismatches.push(calls.length - expected.length + " unexpected extra call(s)");
      return mismatches.length === 0
        ? { pass: true, detail: calls.length + " tool call(s) matched" }
        : { pass: false, detail: mismatches.join("; ") };
    }
    case "turnOrder": {
      const actual = world.turns.map((turn) => turn.bot);
      return deepEqual(actual, assertion.bots)
        ? { pass: true, detail: actual.join(" -> ") }
        : { pass: false, detail: "expected " + assertion.bots.join(" -> ") + ", got " + actual.join(" -> ") };
    }
    case "systemPromptIncludes": {
      const turn = world.turns.find((entry) => entry.bot === assertion.bot && entry.index === assertion.turn);
      return turn === undefined
        ? { pass: false, detail: "no evidence turn " + assertion.turn + " for this bot" }
        : turn.system.includes(assertion.includes)
          ? { pass: true, detail: "system prompt contains the pinned text" }
          : { pass: false, detail: "system prompt lacked: " + assertion.includes + "\n" + turn.system.slice(0, 2000) };
    }
    case "promptIncludes": {
      const turn = world.turns.find((entry) => entry.bot === assertion.bot && entry.index === assertion.turn);
      return turn === undefined
        ? { pass: false, detail: "no evidence turn " + assertion.turn + " for this bot" }
        : turn.prompt.includes(assertion.includes)
          ? { pass: true, detail: "user prompt contains the pinned text" }
          : { pass: false, detail: "prompt lacked: " + assertion.includes + "\n" + fmt(turn.prompt) };
    }
    case "handoffTree": {
      const actual = world.handoffs.map((node) => ({
        bot: node.bot,
        status: node.status,
        ...(node.hasParent === undefined ? {} : { hasParent: node.hasParent }),
      }));
      return deepEqual(actual, assertion.equals)
        ? { pass: true, detail: actual.length + " handoff node(s) matched" }
        : { pass: false, detail: "expected:\n" + fmt(assertion.equals) + "\nactual:\n" + fmt(actual) };
    }
    case "transcriptIncludes": {
      const thread = assertion.thread === "active"
        ? world.activeThreads[assertion.bot]
        : world.handoffs.find((node) => node.bot === assertion.bot)?.threadId;
      if (thread === undefined) return { pass: false, detail: "target thread not found" };
      const messages = world.threads[thread] ?? [];
      return messages.some((message) => (message.text ?? "").includes(assertion.text))
        ? { pass: true, detail: "transcript contains the pinned text" }
        : { pass: false, detail: "transcript lacked: " + assertion.text + "\n" + fmt(messages.map((message) => message.text)) };
    }
    case "gateAnswer": {
      const answer = world.observations[assertion.of] as { held?: boolean; blockedReason?: string; httpStatus?: number } | undefined;
      if (answer === undefined) return { pass: false, detail: "no saved gate answer \"" + assertion.of + "\"" };
      const checks = [
        assertion.held === undefined || answer.held === assertion.held,
        assertion.httpStatus === undefined || answer.httpStatus === assertion.httpStatus,
        assertion.blockedReasonIncludes === undefined ||
          (answer.blockedReason ?? "").includes(assertion.blockedReasonIncludes),
        assertion.blockedReasonOmits === undefined || !(answer.blockedReason ?? "").includes(assertion.blockedReasonOmits),
      ];
      return checks.every(Boolean)
        ? { pass: true, detail: fmt(answer) }
        : { pass: false, detail: "expected " + fmt(assertion) + ", got " + fmt(answer) };
    }
    case "routineRunSnapshot": {
      const snapshot = world.observations[assertion.of] as { status?: string; deferredAt?: number } | undefined;
      if (snapshot === undefined) return { pass: false, detail: "no saved routine snapshot \"" + assertion.of + "\"" };
      const deferred = snapshot.deferredAt != null;
      return snapshot.status === assertion.status && deferred === assertion.deferred
        ? { pass: true, detail: fmt(snapshot) }
        : { pass: false, detail: "expected status " + assertion.status + " deferred=" + assertion.deferred + ", got " + fmt(snapshot) };
    }
    case "activitySeen": {
      const seen = world.activities(assertion.bot).some((name) => name.startsWith(assertion.namePrefix));
      return seen
        ? { pass: true, detail: "activity with prefix \"" + assertion.namePrefix + "\" was recorded" }
        : { pass: false, detail: "no activity with prefix \"" + assertion.namePrefix + "\"" };
    }
    case "noActivityPrefix": {
      const offenders = world.activities(assertion.bot).filter((name) => name.startsWith(assertion.prefix));
      return offenders.length === 0
        ? { pass: true, detail: "no activity with prefix \"" + assertion.prefix + "\"" }
        : { pass: false, detail: "unexpected activities: " + offenders.join(", ") };
    }
    case "activityCount": {
      const matches = world.activities(assertion.bot).filter((name) => name.startsWith(assertion.prefix));
      return matches.length === assertion.count
        ? { pass: true, detail: matches.length + " activity(ies) with prefix \"" + assertion.prefix + "\"" }
        : { pass: false, detail: "expected " + assertion.count + " activity(ies) with prefix \"" + assertion.prefix + "\", got " + matches.length + ": " + matches.join(", ") };
    }
  }
}
