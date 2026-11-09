import { RefIndex } from "../browser-steps.ts";
import { redactSecretsInText } from "../redact.ts";
import type { CdpPage } from "../browser/cdp/page.ts";

export type BrowserClickStep = { origin: string; url: string; role: string; name: string };
export type BrowserOpenStep = { kind: "open"; url: string };
export type BrowserFillStep = BrowserClickStep & { kind: "fill"; value: string };
export type BrowserListQuery = { origin: string; url: string; role: string; prefix: string };
export type BrowserStep = BrowserClickStep | BrowserOpenStep | BrowserFillStep;
export type RecordedBrowserStep = BrowserOpenStep | ((BrowserClickStep | BrowserFillStep) & { observedNames?: string[] });
export type BrowserRecording = { record(step: BrowserStep, observedNames?: readonly string[]): void; unsupported(reason: string): void };
export function createBrowserRecording(): BrowserRecording & { finish(): RecordedBrowserStep[] } {
  const steps: RecordedBrowserStep[] = [];
  let closed = false, incomplete = false;
  return {
    record(step, observedNames) {
      if (closed) return;
      if (steps.length >= 100 || step.url.length > 4096 || ("role" in step && (step.role.length > 100 || step.name.length > 512)) || (observedNames && (observedNames.length > 500 || observedNames.some((name) => name.length > 512 || redactSecretsInText(name) !== name)))) { incomplete = true; return; }
      steps.push({ ...step, ...("role" in step && observedNames ? { observedNames: [...observedNames] } : {}) });
    },
    unsupported() { if (!closed) incomplete = true; },
    finish() {
      if (closed) throw new Error("Browser recording is already closed");
      closed = true;
      if (incomplete || !steps.length) throw new Error("The browser recording is incomplete");
      return structuredClone(steps);
    },
  };
}
type Snapshot = { url: string; tree: string; truncated: boolean; frames: number };
export interface ExclusiveBrowser {
  snapshot(signal: AbortSignal): Promise<Snapshot>;
  click(ref: string, signal: AbortSignal): Promise<void>;
}

function snapshotIndex(snapshot: Snapshot): RefIndex {
  if (snapshot.truncated !== false || snapshot.frames !== 1 || !snapshot.tree || snapshot.tree.includes("(frame not readable:")) throw new Error("The page could not be fully inspected");
  const refs = new RefIndex();
  refs.replace([snapshot.tree]);
  return refs;
}

export function listBrowserTargets(snapshot: Snapshot, query: BrowserListQuery): BrowserClickStep[] {
  const url = new URL(query.url);
  if (!["http:", "https:"].includes(url.protocol) || url.href !== query.url || url.origin !== query.origin || url.username || url.password || new URL(snapshot.url).href !== url.href) throw new Error("The browser is on a different or invalid page");
  return snapshotIndex(snapshot).matchingTargets(query.role, query.prefix).map((target) => ({ origin: query.origin, url: query.url, ...target }));
}

export function browserPeerNames(snapshot: Snapshot, role: string): string[] {
  return snapshotIndex(snapshot).namedTargets(role);
}

/** Never save a password, code or other explicitly secret-looking field. */
export function safeBrowserFill(step: BrowserFillStep): boolean {
  return /^(?:textbox|searchbox|combobox)$/i.test(step.role) && !/pass|pwd|otp|one.?time|2fa|mfa|security.?code|verif\w*.?code|cvc|cvv|card.?num|\bpin\b|ssn|secret|token/i.test(step.name) && step.value.length <= 4096 && redactSecretsInText(step.value) === step.value;
}

export async function safeBrowserFillTarget(page: CdpPage, ref: string, step: BrowserFillStep): Promise<boolean> {
  if (!safeBrowserFill(step)) return false;
  const handle = page.refs.resolve(ref);
  const { node } = await handle.session.send<{ node: { nodeName?: string; attributes?: string[] } }>("DOM.describeNode", { backendNodeId: handle.backendNodeId });
  if (!node || !["INPUT", "TEXTAREA"].includes(node.nodeName ?? "") || !Array.isArray(node.attributes) || node.attributes.length % 2) return false;
  const attrs = new Map<string, string>();
  for (let i = 0; i < node.attributes.length; i += 2) attrs.set(node.attributes[i]!.toLowerCase(), node.attributes[i + 1]!.toLowerCase());
  const type = attrs.get("type") ?? "text", autocomplete = attrs.get("autocomplete") ?? "";
  return ["text", "search", "email", "url", "tel"].includes(type) && !/(?:password|one-time-code|cc-|webauthn)/i.test(autocomplete);
}

/** Turn a first-run reference into an identity, never saving transient references or selectors. */
export function captureBrowserClick(snapshot: Snapshot, selector: string): BrowserClickStep {
  const url = new URL(snapshot.url);
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.href !== snapshot.url) throw new Error("Invalid browser page");
  const refs = snapshotIndex(snapshot), target = refs.get(selector);
  const unique = target && refs.uniqueTarget(target.role, target.name, true);
  if (!target || !unique || unique !== `@${selector.replace(/^@/, "")}`) throw new Error("The browser target is missing or ambiguous");
  return { origin: url.origin, url: url.href, role: target.role, name: target.name };
}

/** The host must hold the browser's existing control gate and exclusive lane across both calls. */
export async function replayBrowserClick(step: BrowserClickStep, exclusive: (work: (session: ExclusiveBrowser) => Promise<void>) => Promise<void>, signal: AbortSignal): Promise<void> {
  const origin = new URL(step.origin);
  if (!(["https:", "http:"].includes(origin.protocol)) || origin.origin !== step.origin || origin.username || origin.password) throw new Error("Invalid approved browser origin");
  const approvedUrl = new URL(step.url);
  if (approvedUrl.origin !== origin.origin || approvedUrl.href !== step.url || approvedUrl.username || approvedUrl.password) throw new Error("Invalid approved browser page");
  signal.throwIfAborted();
  await exclusive(async (session) => {
    const snapshot = await session.snapshot(signal);
    signal.throwIfAborted();
    if (new URL(snapshot.url).href !== approvedUrl.href) throw new Error("The browser is on a different page");
    const refs = snapshotIndex(snapshot);
    const ref = refs.uniqueTarget(step.role, step.name, true);
    if (!ref) throw new Error("The browser target is missing, ambiguous or the page could not be fully inspected");
    signal.throwIfAborted();
    await session.click(ref, signal);
  });
}
