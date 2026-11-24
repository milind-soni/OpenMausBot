// Adapted from packages/client-runtime/src/connection/diagnosis.ts at commit abc0fde5, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: the steps are this computer's own (phone link,
// account, relay, the phone's way in) read from the state the desktop already holds, every line is localised, and the
// copied text carries only fixed words and codes.
import type { CompanionAccountState } from "../types/ogb";
import { companionPairingRoute, type CompanionPairingRouteSource } from "./companion-pairing";
import type { CompanionState } from "./companion-types";
import { t } from "./i18n";

export type RemoteAccessStepId = "computer" | "account" | "relay" | "route";
export type RemoteAccessStepResult = "ok" | "failed" | "unchecked";

export interface RemoteAccessStep {
  id: RemoteAccessStepId;
  label: string;
  result: RemoteAccessStepResult;
  reason: string;
}

export interface RemoteAccessDiagnosis {
  /** The first failed step's reason, or how it stands when nothing failed. */
  headline: string;
  steps: RemoteAccessStep[];
  /** What the person can do, for the first failed step. */
  next: string[];
  /** For the copied text only: fixed keys, and values that are codes, counts, yes/no or a version. */
  facts: Array<[string, string]>;
  failed: boolean;
}

export interface RemoteAccessFacts {
  account: Pick<CompanionAccountState, "available" | "status" | "problem"> | null;
  companion: (CompanionPairingRouteSource & Pick<CompanionState, "enabled" | "error" | "routes" | "e2e" | "devices" | "relayToken">) | null;
  setupTimedOut?: boolean;
  appVersion?: string | null;
  /** The account is needed even with Anywhere and the HTTPS address off: the pairing screen is asking for it. */
  accountWanted?: boolean;
}

type Problem = { reason: string; next: string[] };
type AccountProblem = NonNullable<CompanionAccountState["problem"]>;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;
const RELAY_NODE = /^(relay[1-9][0-9]?)\.openmausbot\.com$/;
const ACCOUNT_PROBLEMS: ReadonlySet<string> = new Set<AccountProblem>(["unconfigured", "unreachable", "sign_in", "busy", "limit", "update", "address", "failed"]);
const TOKEN_CODES: ReadonlySet<string> = new Set(["unavailable", "sign_in", "busy", "unreachable", "failed"]);
const RELAY_PROBLEMS: ReadonlySet<string> = new Set(["no_answer", "token_refused", "busy", "unreachable", "replaced"]);

const known = (value: unknown, words: ReadonlySet<string>): string | null => (typeof value === "string" && words.has(value) ? value : null);

function accountProblem(problem: string | null): Problem {
  switch (problem) {
    case "unreachable":
      return { reason: t("remote.diagnosis.account.unreachable"), next: [t("remote.diagnosis.next.internet")] };
    case "sign_in":
      return { reason: t("remote.diagnosis.account.expired"), next: [t("remote.diagnosis.next.signIn")] };
    case "busy":
      return { reason: t("remote.diagnosis.account.busy"), next: [t("remote.diagnosis.next.wait")] };
    case "limit":
      return { reason: t("remote.diagnosis.account.limit"), next: [t("remote.diagnosis.next.removeComputer")] };
    case "update":
      return { reason: t("remote.diagnosis.account.update"), next: [t("remote.diagnosis.next.update")] };
    default:
      return { reason: t("remote.diagnosis.account.failed"), next: [t("remote.diagnosis.next.retry"), t("remote.diagnosis.next.support")] };
  }
}

const hasWifiAddress = (companion: NonNullable<RemoteAccessFacts["companion"]>) => companionPairingRoute(companion, "local") !== null;

interface Evaluated {
  result: RemoteAccessStepResult;
  reason: string;
  next?: string[];
}

function computerStep(companion: RemoteAccessFacts["companion"]): Evaluated {
  if (!companion) return { result: "unchecked", reason: t("remote.diagnosis.notChecked") };
  if (companion.error) return { result: "failed", reason: t("remote.diagnosis.computer.failed"), next: [t("remote.diagnosis.next.restart")] };
  if (!companion.enabled) return { result: "failed", reason: t("remote.diagnosis.computer.off"), next: [t("remote.diagnosis.next.turnOn")] };
  return { result: "ok", reason: t("remote.diagnosis.computer.on") };
}

function accountStep(facts: RemoteAccessFacts): Evaluated {
  const { account, companion } = facts;
  if (!account) return { result: "unchecked", reason: t("remote.diagnosis.notChecked") };
  const problem = known(account.problem, ACCOUNT_PROBLEMS);
  if (problem === "unconfigured") return { result: "unchecked", reason: t("remote.diagnosis.account.unconfigured") };
  const used = companion?.routes?.relay?.on === true || companion?.routes?.https?.on === true;
  if (!used && !facts.accountWanted) return { result: "unchecked", reason: t("remote.diagnosis.account.notNeeded") };
  if (!account.available) return { result: "failed", ...accountProblem(problem ?? "unreachable") };
  if (account.status === "signed-out") {
    return { result: "failed", reason: t("remote.diagnosis.account.signedOut"), next: [t("remote.diagnosis.next.signIn")] };
  }
  if (account.status === "connecting") return { result: "unchecked", reason: t("remote.diagnosis.connecting") };
  // A failing HTTPS address is not the account's failure: the phone's way in reports it.
  if (account.status === "error" && problem !== "address") {
    return { result: "failed", ...accountProblem(problem) };
  }
  if (companion?.relayToken?.state === "waiting") {
    return { result: "failed", reason: t("remote.diagnosis.account.credential"), next: [t("remote.diagnosis.next.askAgain")] };
  }
  return { result: "ok", reason: t("remote.diagnosis.account.signedIn") };
}

function relayStep(facts: RemoteAccessFacts, accountResult: RemoteAccessStepResult): Evaluated {
  const companion = facts.companion;
  if (!companion || companion.routes?.relay?.on !== true) return { result: "unchecked", reason: t("remote.diagnosis.relay.off") };
  const e2e = companion.e2e;
  if (e2e?.enabled === true && e2e.relay === "connected") return { result: "ok", reason: t("remote.diagnosis.relay.connected") };
  if (accountResult === "failed") return { result: "unchecked", reason: t("remote.diagnosis.relay.needsAccount") };
  if (e2e?.relayProblem === "replaced") {
    return { result: "failed", reason: t("remote.diagnosis.relay.replaced"), next: [t("remote.diagnosis.next.otherCopy")] };
  }
  const token = companion.relayToken;
  const tokenCode = known(token?.code, TOKEN_CODES);
  if (token?.state === "off") return { result: "unchecked", reason: t("remote.diagnosis.relay.idle") };
  if (token?.state === "failed") {
    if (tokenCode === "unavailable") {
      return { result: "failed", reason: t("remote.diagnosis.relay.unavailable"), next: [t("remote.diagnosis.next.useWifi")] };
    }
    if (tokenCode === "busy") {
      return { result: "failed", reason: t("remote.diagnosis.relay.busy"), next: [t("remote.diagnosis.next.wait")] };
    }
    if (tokenCode === "unreachable") {
      return { result: "failed", reason: t("remote.diagnosis.account.unreachable"), next: [t("remote.diagnosis.next.internet")] };
    }
    return { result: "failed", reason: t("remote.diagnosis.relay.noAccess"), next: [t("remote.diagnosis.next.wait"), t("remote.diagnosis.next.support")] };
  }
  if (e2e?.enabled !== true || token?.state === "fetching") return { result: "unchecked", reason: t("remote.diagnosis.connecting") };
  switch (e2e.relayProblem) {
    case "no_answer":
      return { result: "failed", reason: t("remote.diagnosis.relay.noAnswer"), next: [t("remote.diagnosis.next.internet"), t("remote.diagnosis.next.vpn")] };
    case "unreachable":
      return { result: "failed", reason: t("remote.diagnosis.relay.unreachable"), next: [t("remote.diagnosis.next.internet"), t("remote.diagnosis.next.vpn")] };
    case "busy":
      return { result: "failed", reason: t("remote.diagnosis.relay.busy"), next: [t("remote.diagnosis.next.wait")] };
    default:
      return { result: "unchecked", reason: t("remote.diagnosis.connecting") };
  }
}

function routeStep(facts: RemoteAccessFacts, relay: RemoteAccessStepResult): Evaluated {
  const companion = facts.companion;
  if (!companion?.enabled || companion.error) return { result: "unchecked", reason: t("remote.diagnosis.notChecked") };
  if (relay === "ok") return { result: "ok", reason: t("remote.diagnosis.route.anywhere") };
  const on = (route: "wifi" | "relay" | "tailscale" | "https") => companion.routes?.[route]?.on === true;
  if (on("wifi") && hasWifiAddress(companion)) return { result: "ok", reason: t("remote.diagnosis.route.wifi") };
  if (on("tailscale") && companion.routes?.tailscale?.name) return { result: "ok", reason: t("remote.diagnosis.route.privateNetwork") };
  if (on("https") && facts.account?.problem === "address") {
    return { result: "failed", reason: t("remote.diagnosis.route.https"), next: [t("remote.diagnosis.next.retry"), t("remote.diagnosis.next.useWifi")] };
  }
  if (on("wifi")) return { result: "failed", reason: t("remote.diagnosis.route.noWifi"), next: [t("remote.diagnosis.next.joinWifi")] };
  if (on("relay")) {
    return relay === "unchecked"
      ? { result: "unchecked", reason: t("remote.diagnosis.connecting") }
      : { result: "failed", reason: t("remote.diagnosis.route.none"), next: [t("remote.diagnosis.next.useWifi")] };
  }
  return { result: "failed", reason: t("remote.diagnosis.route.off"), next: [t("remote.diagnosis.next.turnOn")] };
}

const ROUTES = ["wifi", "relay", "tailscale", "https"] as const;

function factsOf(facts: RemoteAccessFacts): Array<[string, string]> {
  const { account, companion } = facts;
  const out: Array<[string, string]> = [];
  const add = (key: string, value: string | null | undefined) => {
    if (value) out.push([key, value]);
  };
  add("app", typeof facts.appVersion === "string" && VERSION.test(facts.appVersion) ? facts.appVersion : null);
  if (account) {
    const status = known(account.status, new Set(["signed-out", "connecting", "ready", "error"])) ?? "unknown";
    const problem = known(account.problem, ACCOUNT_PROBLEMS);
    add("account", `${account.available ? status : "unavailable"}${problem ? ` (${problem})` : ""}`);
  }
  if (companion) {
    add("phone_link", companion.error ? "error" : companion.enabled ? "on" : "off");
    add("ways_on", ROUTES.filter((route) => companion.routes?.[route]?.on === true).join(",") || "none");
    add("wifi_address", hasWifiAddress(companion) ? "yes" : "no");
    add("encrypted", companion.e2e?.enabled === true ? "on" : "off");
    const relay = companion.e2e?.relay;
    const node = companion.e2e?.node?.match(RELAY_NODE)?.[1] ?? null;
    const problem = known(companion.e2e?.relayProblem, RELAY_PROBLEMS);
    if (relay === "connected" || relay === "connecting" || relay === "off") add("relay", `${relay}${node ? ` ${node}` : ""}${problem ? ` (${problem})` : ""}`);
    const token = companion.relayToken;
    const tokenState = known(token?.state, new Set(["off", "fetching", "ready", "failed", "waiting"]));
    const tokenCode = known(token?.code, TOKEN_CODES);
    if (tokenState) add("relay_access", `${tokenState}${tokenCode ? ` (${tokenCode})` : ""}`);
    add("paired", String(Array.isArray(companion.devices) ? Math.min(companion.devices.length, 100) : 0));
  }
  if (facts.setupTimedOut) add("setup", "timed_out");
  return out;
}

/** Where this computer's remote access stands, step by step, from the state the desktop already has. */
export function diagnoseRemoteAccess(facts: RemoteAccessFacts): RemoteAccessDiagnosis {
  const computer = computerStep(facts.companion);
  const account = computer.result === "failed" ? { result: "unchecked" as const, reason: t("remote.diagnosis.notChecked") } : accountStep(facts);
  const relay = computer.result === "failed" ? { result: "unchecked" as const, reason: t("remote.diagnosis.notChecked") } : relayStep(facts, account.result);
  const route = routeStep(facts, relay.result);
  const evaluated: Array<[RemoteAccessStepId, string, Evaluated]> = [
    ["computer", t("remote.diagnosis.step.computer"), computer],
    ["account", t("remote.diagnosis.step.account"), account],
    ["relay", t("remote.diagnosis.step.relay"), relay],
    ["route", t("remote.diagnosis.step.route"), route],
  ];
  const steps = evaluated.map(([id, label, step]): RemoteAccessStep => ({ id, label, result: step.result, reason: step.reason }));
  const first = evaluated.find(([, , step]) => step.result === "failed")?.[2];
  const waiting = steps.some((step) => step.result === "unchecked" && step.id !== "relay");
  return {
    headline: first?.reason ?? (route.result === "ok" ? route.reason : waiting ? t("remote.diagnosis.connecting") : t("remote.diagnosis.allClear")),
    steps,
    next: first?.next ?? [],
    facts: factsOf(facts),
    failed: Boolean(first),
  };
}

const MARK = { ok: "remote.diagnosis.mark.ok", failed: "remote.diagnosis.mark.failed", unchecked: "remote.diagnosis.mark.unchecked" } as const;

export const remoteAccessStepMark = (result: RemoteAccessStepResult): string => t(MARK[result]);

/** One plain-text block to paste into a support message. It holds the localised lines above and the facts, nothing
 * else: no email, address, token, pairing code or key. */
export function remoteAccessDiagnosisText(diagnosis: RemoteAccessDiagnosis): string {
  return [
    t("remote.diagnosis.copyTitle", { headline: diagnosis.headline }),
    "",
    ...diagnosis.steps.map((step) => `${step.label}: ${remoteAccessStepMark(step.result)} · ${step.reason}`),
    ...(diagnosis.next.length ? ["", ...diagnosis.next.map((line) => `- ${line}`)] : []),
    "",
    ...diagnosis.facts.map(([key, value]) => `${key}: ${value}`),
  ].join("\n");
}
