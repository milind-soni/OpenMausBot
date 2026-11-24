// Why an engine can't run now and how the person connects it, for list_models. A bot once read "unavailable" next to
// Google's engine and told someone it needed a paid API key; it signs in with a Google account. So every engine a bot
// sees as unusable carries both, built from what Settings' provider card is built from: the engine's status, its
// install descriptor, its sign-in method and whether it takes only an API key (shared/engine-sign-in.ts).
import { keyOnlyEngine } from "../../shared/engine-sign-in.ts";
import { placePath } from "../app-settings/places.ts";
import type { EngineAccess, EngineInstall, ProviderSnapshot } from "../contracts.ts";

export interface EngineHint {
  /** Why it can't run now. */
  why: string;
  /** What the person does to connect it, and where. */
  connect: string;
}

export interface EngineHintInput {
  name: string;
  driverKind: string;
  enabled: boolean;
  access: EngineAccess | undefined;
  /** The last status read; none yet reads as nothing known. */
  snapshot: ProviderSnapshot | undefined;
  install: EngineInstall | undefined;
  /** How the app signs it in, when it can (the provider card's sign-in button). */
  signIn: { method: string } | undefined;
  /** The account whose subscription that sign-in uses (driver metadata signInAccount). */
  account?: string;
  /** The organization's rule that turns it off here. */
  policy?: string;
  /** False when this server does not offer it. */
  offered?: boolean;
  /** Its saved settings could not be read. */
  broken?: true;
  /** Set up by a company: never a key of the person's own. */
  managed?: true;
}

const REASON_CHARS = 160;
const clip = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1)}…` : line;
};

export function engineHint(engine: EngineHintInput): EngineHint {
  const providers = placePath("providers");
  const key = `save its API key in ${placePath("keys")} (use is billed to that key)`;
  const snapshot = engine.snapshot;
  const keyOnly = keyOnlyEngine({ ...engine, snapshot: snapshot ?? {} }) || engine.install?.settings === "connections";
  // A named account is a subscription sign-in (Google, ChatGPT, Claude); any other app sign-in only replaces a key.
  const signIn = engine.account
    ? `sign in with your ${engine.account} account in ${providers}; a subscription on that account covers it, no API key`
    : `sign in with your ${engine.name.replace(/\s*\(.*\)$/u, "")} account in ${providers}; no API key needed`;
  if (engine.broken) return { why: "its saved settings can't be read", connect: `fix or remove it in ${providers}` };
  if (!engine.enabled) return { why: "turned off", connect: `turn it on in ${providers}` };
  if (engine.policy) return { why: "not allowed by the organization", connect: clip(engine.policy) };
  if (engine.offered === false) return { why: "not offered on this server", connect: "its admin chooses which AIs it offers" };
  if (engine.managed) return { why: snapshot?.authenticated === false ? "not signed in" : "can't run now", connect: "the company that manages it fixes this: ask its admin" };
  if (snapshot?.installing) return { why: "being installed now", connect: "nothing to do: it is ready in a few minutes" };
  if (snapshot?.notEngineCli) return { why: "its program path runs another program", connect: `reset the path in ${providers}` };
  if (snapshot?.ollama) {
    const why = snapshot.ollama.state === "no-models" ? "its Ollama has no models yet" : "its Ollama server is not answering";
    return { why, connect: `start Ollama and pull a model, or change its address in ${providers}` };
  }
  // The driver's own reason it can't sign in here wins (a ChatGPT plan on a Cloud says what to use instead).
  if (snapshot?.authenticationUnavailableReason) return { why: "can't be signed in here", connect: clip(snapshot.authenticationUnavailableReason) };
  const installed = snapshot?.state === "available" || Boolean(snapshot?.version);
  if (installed && snapshot?.authenticated === false) {
    if (keyOnly) return { why: "no working API key saved", connect: key };
    if (engine.signIn && engine.access !== "api") return { why: "not signed in", connect: signIn };
    const command = engine.install?.signInCommand;
    return { why: "not signed in", connect: command ? `run \`${clip(command)}\` in a terminal on the computer the bots run on, or follow ${providers}` : `sign in from ${providers}` };
  }
  if (snapshot?.state === "unavailable" && !snapshot.version) {
    // The app downloads a managed runtime as part of its sign-in: nothing to install first.
    if (engine.install?.managed && engine.signIn) return { why: "not set up yet", connect: `${signIn} (the app installs it first)` };
    if (keyOnly && !engine.install?.command && !engine.install?.server) return { why: "no API key saved", connect: key };
    // Claude's API-key instance has a sign-in too: an "api" engine is never said to need no key.
    const then = keyOnly || engine.access === "api" ? `, then ${key}` : engine.signIn ? ", then sign in there with that provider's account (no API key)" : "; it then shows how it signs in";
    return { why: "not installed", connect: `install it in ${providers}${then}` };
  }
  // Installed but refused for its own reason (a key it needs, a check that failed): the key when it takes only one.
  if (snapshot?.state === "unavailable" && keyOnly) return { why: "no working API key saved", connect: key };
  return { why: "can't run now", connect: `${providers} shows why` };
}

/** The hints for a running server: the registry holds the status and how each engine connects, read without probing. */
export function createEngineHints(deps: {
  registry: {
    get(instanceId: string): { driverKind: string; displayName: string | undefined; enabled: boolean; models: { default: string } } | null;
    knownSnapshot(instanceId: string): ProviderSnapshot | undefined;
    connection(instanceId: string): { install: EngineInstall | undefined; signIn: { method: string } | undefined; account: string | undefined };
    entries(): ReadonlyArray<{ shadow?: { driverKind: string; displayName: string | undefined } }>;
  };
  /** The engine's access as Settings has it (a saved override, else its driver's). */
  access(instanceId: string): EngineAccess | undefined;
  /** Set up by a company, not by the person. */
  managed(instanceId: string): boolean;
  policy(instance: { instanceId: string; driverKind: string }): string | undefined;
  offered?(selection: { instanceId: string; model: string }): boolean;
}) {
  const providers = () => placePath("providers");
  return {
    hint(instanceId: string): EngineHint {
      const live = deps.registry.get(instanceId);
      if (!live) return { why: "not set up", connect: `add it in ${providers()}` };
      const { install, signIn, account } = deps.registry.connection(instanceId);
      const policy = deps.policy({ instanceId, driverKind: live.driverKind });
      return engineHint({
        name: live.displayName || live.driverKind, driverKind: live.driverKind, enabled: live.enabled, access: deps.access(instanceId),
        snapshot: deps.registry.knownSnapshot(instanceId), install, signIn, ...(account ? { account } : {}),
        ...(deps.managed(instanceId) ? { managed: true as const } : {}),
        ...(policy ? { policy } : {}),
        ...(deps.offered && !deps.offered({ instanceId, model: live.models.default }) ? { offered: false } : {}),
      });
    },
    broken: () => deps.registry.entries().flatMap(({ shadow }) => shadow
      ? [{ name: shadow.displayName || shadow.driverKind, hint: engineHint({ name: "", driverKind: shadow.driverKind, enabled: true, access: undefined, snapshot: undefined, install: undefined, signIn: undefined, broken: true }) }]
      : []),
  };
}
