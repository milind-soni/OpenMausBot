// In-memory ProviderDriver for registry/bus tests: tests emit canonical events through the returned handle.
import type {
  DriverCreateInput,
  EffortLevel,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
} from "../contracts.ts";

export interface FakeDriverOptions {
  kind?: string;
  /** create() rejects with this message (shadow-downgrade path). */
  failCreate?: string;
  /** snapshot() rejects with this message (describe-downgrade path). */
  failSnapshot?: string;
  /** snapshot() never settles, like a status probe stuck on its CLI. */
  hangSnapshot?: boolean;
  /** snapshot() answers only once this settles, so a test can hold a probe in flight. */
  holdSnapshot?: Promise<unknown>;
  /** What snapshot() answers instead of an available engine. */
  answer?: ProviderSnapshot;
  /** effort levels this fake driver declares, forwarded onto capabilities. */
  effortLevels?: readonly EffortLevel[];
}

export interface FakeDriverHandle {
  driver: ProviderDriver<Record<string, unknown>>;
  /** Live instances by instanceId, with their event-emit hook. */
  created: Map<string, { instance: ProviderInstance; emit: (e: RuntimeEvent) => void }>;
  decodedConfigs: unknown[];
  disposed: string[];
  /** One instance id per status probe the driver ran: a real driver spawns its CLI for each. */
  probes: string[];
}

export function makeFakeDriver(opts: FakeDriverOptions = {}): FakeDriverHandle {
  const kind = opts.kind ?? "fake";
  const handle: FakeDriverHandle = {
    created: new Map(),
    decodedConfigs: [],
    disposed: [],
    probes: [],
    driver: {
      driverKind: kind,
      metadata: { displayName: `Fake ${kind}` },
      models: { default: `${kind}-1`, options: [{ id: `${kind}-1`, label: `${kind} one` }] },
      decodeConfig(raw: unknown) {
        if (raw && typeof raw === "object" && (raw as Record<string, unknown>).bad) {
          throw new Error(`${kind}: bad config`);
        }
        handle.decodedConfigs.push(raw);
        return (raw ?? {}) as Record<string, unknown>;
      },
      defaultConfig: () => ({ isDefault: true }),
      async create(input: DriverCreateInput<Record<string, unknown>>): Promise<ProviderInstance> {
        if (opts.failCreate) throw new Error(opts.failCreate);
        const listeners = new Set<RuntimeEventListener>();
        const emit = (event: RuntimeEvent) => {
          for (const l of Array.from(listeners)) l(event);
        };
        const instance: ProviderInstance = {
          instanceId: input.instanceId,
          driverKind: kind,
          displayName: input.displayName,
          enabled: input.enabled,
          models: handle.driver.models,
          snapshot: async (): Promise<ProviderSnapshot> => {
            handle.probes.push(input.instanceId);
            if (opts.failSnapshot) throw new Error(opts.failSnapshot);
            if (opts.hangSnapshot) await new Promise<never>(() => {});
            if (opts.holdSnapshot) await opts.holdSnapshot;
            return opts.answer ?? { state: "available", version: "0.0.0-fake" };
          },
          adapter: {
            provider: kind,
            capabilities: { sessionModelSwitch: "unsupported", effortLevels: opts.effortLevels },
            sendTurn: async () => ({ turnId: "fake-turn" }),
            interruptTurn: async () => {},
            respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
            hasSession: () => false,
            stopAll: async () => {},
            onEvent: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          dispose: async () => {
            handle.disposed.push(input.instanceId);
            listeners.clear();
          },
        };
        handle.created.set(input.instanceId, { instance, emit });
        return instance;
      },
    },
  };
  return handle;
}
