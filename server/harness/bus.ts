// Fan-in event bus — port of upstream's ProviderService fan-in +
// EventNdjsonLogger tee, minus Effect. Every adapter's event stream merges
// into one bus; each event is stamped with its providerInstanceId, teed to
// a per-thread canonical NDJSON log (the debugging trick both upstream and
// agentcal lean on), and delivered to subscribers (the SSE endpoint and
// the server-side message folder).
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { protectedEnvironmentValues, redactKnownValues, redactSecrets } from "../redact.ts";
import type { ProviderInstance, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";

const INTERNAL_TURN_TOKEN = Symbol("openmaus.internal-runtime-turn-token");

/** Return the exact in-process turn lease without making it serializable.
 * The public event shape stays redacted for NDJSON, SSE, transcripts, and
 * object spreads; graph orchestration uses this proof only for correlation. */
export function internalRuntimeTurnToken(event: RuntimeEvent): string | undefined {
  const value = (event as RuntimeEvent & { [INTERNAL_TURN_TOKEN]?: unknown })[INTERNAL_TURN_TOKEN];
  return typeof value === "string" ? value : undefined;
}

export class EventBus {
  private listeners = new Set<RuntimeEventListener>();
  private admissionGuards = new Set<(event: RuntimeEvent) => boolean>();
  private unsubscribes: Array<() => void> = [];

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      const unsub = instance.adapter.onEvent((event) => {
        // hard invariant borrowed from correlateRuntimeEventWithInstance:
        // an adapter may only emit events for its own driver kind
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      this.unsubscribes.push(unsub);
    }
  }

  publish(event: RuntimeEvent) {
    // Redact before BOTH persistence and delivery. The message-store fold is
    // a listener, so logging-only redaction would still leave a canary copied
    // by a provider in the durable transcript and subsequent replay context.
    const sanitized = redactKnownValues(
      redactSecrets(event),
      protectedEnvironmentValues(),
    ) as RuntimeEvent;
    if (typeof event.turnToken === "string") {
      Object.defineProperty(sanitized, INTERNAL_TURN_TOKEN, {
        value: event.turnToken,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
    // Security/ownership admission happens before the diagnostic tee and
    // before every subscriber. A rejected graph event must not reach
    // telemetry, watchdogs, SSE, transcripts, routines, or approval cards.
    for (const guard of [...this.admissionGuards]) {
      try {
        if (!guard(sanitized)) return;
      } catch (error) {
        console.error("bus: admission guard threw; event dropped", error);
        return;
      }
    }
    try {
      // the canonical log is a file people paste into bug reports; scrub
      // credential-shaped content (tool titles, request summaries, reply
      // text) the same way the native tee does
      appendFileSync(
        join(EVENTS_DIR, `${event.threadId}.ndjson`),
        JSON.stringify(sanitized) + "\n",
        { mode: 0o600 },
      );
    } catch {
      /* logging must never take down the stream */
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(sanitized);
      } catch (e) {
        console.error("bus: listener threw", e);
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addAdmissionGuard(guard: (event: RuntimeEvent) => boolean): () => void {
    this.admissionGuards.add(guard);
    return () => this.admissionGuards.delete(guard);
  }

  detachAll() {
    for (const unsub of this.unsubscribes.splice(0)) unsub();
  }
}
