import type { InstanceInfo, ModelSelection } from "@/state/store";
import { needsCli, needsSignIn } from "@/components/EngineSetup";
import { t } from "./i18n";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "./custom-models";
import { isCustomOnly, SIGN_IN_FAMILY_LABEL, signInFamily, splitEngineRail } from "./engine-rail";
import { displayModelLabel, shortModelLabel } from "./model-friendly";
import { choiceIsSelected, modelChoices, type ModelChoice } from "./model-choices";

export type ModelOption = InstanceInfo["models"]["options"][number];

export const SIMPLE_SEARCH_AFTER = 12;
export const CURRENT_GROUP_SUGGESTIONS = 4;
export const GROUP_SUGGESTIONS = 3;

export interface MenuModelRow {
  option: ModelChoice;
  model?: string;
  variant?: string;
  label: string;
  route?: string;
  current: boolean;
}

export type MenuGroupBody =
  | { kind: "policy"; organization: string }
  | { kind: "setUp" }
  | { kind: "signIn" }
  | { kind: "empty"; loading: boolean }
  | {
    kind: "models";
    rows: MenuModelRow[];
    total: number;
    toggle: "more" | "less" | null;
    localFrom: number | null;
    signInForOwn: boolean;
    probing: boolean;
  };

export interface MenuGroup {
  instance: InstanceInfo;
  label: string;
  provider: string;
  account?: string;
  body: MenuGroupBody;
}

export interface MenuCurrent {
  instance?: InstanceInfo;
  label: string;
  title: string;
  meta?: string;
  warning: boolean;
  pending: boolean;
}

export interface SimpleMenu {
  current: MenuCurrent | null;
  follow: boolean;
  groups: MenuGroup[];
  search: boolean;
  query: string;
  results: number | null;
  empty: "loading" | "none" | null;
  busy: boolean;
}

export interface SimpleMenuInput {
  instances: readonly InstanceInfo[];
  listed: readonly InstanceInfo[];
  selection: ModelSelection;
  bot: { name: string; selection: ModelSelection; follows?: boolean };
  query: string;
  expanded: ReadonlySet<string>;
  probing: ReadonlySet<string>;
  loading: boolean;
  refreshing?: string | null;
}

export function providerName(instance: InstanceInfo): string {
  const family = signInFamily(instance);
  if (family) return SIGN_IN_FAMILY_LABEL[family];
  if (instance.access !== "api") return instance.displayName;
  return instance.displayName.replace(/\s*\((?:API key|API)\)$/i, "") || instance.displayName;
}

export function modelName(instance: InstanceInfo | undefined, model: string): string {
  const option = instance?.models.options.find((candidate) => candidate.id === model);
  if (!instance || !option) return model;
  return displayModelLabel(option.label, providerName(instance), option.custom);
}

export function repeatedModelLabels(options: readonly ModelOption[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const option of options) (seen.has(option.label) ? repeated : seen).add(option.label);
  return repeated;
}

function listedModels(instance: InstanceInfo) {
  const signedOut = !isCustomOnly(instance) && needsSignIn(instance);
  const own = isCustomOnly(instance) || signedOut ? [] : modelChoices(instance, instance.models.options.filter((option) => !option.custom));
  const local = partitionCustomModels(instance.models.options.filter((option) => option.custom));
  return { signedOut, own, all: [...own, ...local.pinned, ...local.rest] };
}

function localFrom(rows: readonly MenuModelRow[], mixed: boolean): number | null {
  if (!mixed) return null;
  const first = rows.findIndex((row) => row.option.custom);
  return first >= 0 && rows.slice(first).every((row) => row.option.custom) ? first : null;
}

function heading(instance: InstanceInfo, listed: readonly InstanceInfo[]): Pick<MenuGroup, "label" | "provider" | "account"> {
  const provider = providerName(instance);
  const family = signInFamily(instance);
  if (instance.access === "api") return { label: `${provider} · ${t("model.simple.apiKey")}`, provider };
  const several = family !== undefined && listed.filter((other) => signInFamily(other) === family).length > 1;
  const account = several && instance.displayName !== provider ? instance.displayName : undefined;
  return { label: account ? `${provider} · ${account}` : provider, provider, account };
}

function currentRow(input: SimpleMenuInput): MenuCurrent {
  const { instances, selection, bot, loading } = input;
  const active = instances.find((instance) => instance.instanceId === selection.instanceId);
  const option = active?.models.options.find((candidate) => candidate.id === selection.model);
  const name = option?.label ?? selection.model;
  const row = { instance: active, label: modelName(active, selection.model), title: active ? `${active.displayName} · ${name}` : name, warning: false, pending: false };
  if (!active) return loading ? { ...row, pending: true } : { ...row, meta: t("model.simple.unavailable"), warning: true };
  if (!option && input.refreshing === active.instanceId) return { ...row, pending: true };
  if (active.policy) return { ...row, meta: t("policy.managedBy", { organization: active.policy.organizationName }), warning: true };
  if (needsCli(active)) return { ...row, meta: t("model.setupRequired"), warning: true };
  if (needsSignIn(active) && !isCustomOnly(active) && !option?.custom) return { ...row, meta: t("model.signInRequired"), warning: true };
  if (bot.follows === true) return { ...row, meta: t("model.simple.botsModel", { name: bot.name }) };
  const family = signInFamily(active);
  const accounts = family ? instances.filter((instance) => signInFamily(instance) === family).length : 0;
  if (accounts > 1 || active.snapshot.chatgptPlan) return { ...row, meta: active.displayName };
  return option?.provider ? { ...row, meta: option.provider } : row;
}

export function simpleModelMenu(input: SimpleMenuInput): SimpleMenu {
  const { listed, selection, bot, expanded, probing } = input;
  const models = new Map(listed.map((instance) => [instance.instanceId, listedModels(instance)]));
  const total = listed.filter((instance) => !instance.policy && !needsCli(instance))
    .reduce((sum, instance) => sum + models.get(instance.instanceId)!.all.length, 0);
  const search = total > SIMPLE_SEARCH_AFTER;
  const query = search ? input.query.trim() : "";
  const { subscription, api, custom } = splitEngineRail(listed);
  const ordered = [...subscription, ...api, ...custom];
  const current = ordered.find((instance) => instance.instanceId === selection.instanceId);

  function groupBody(instance: InstanceInfo, provider: string): MenuGroupBody | null {
    if (instance.policy) return query ? null : { kind: "policy", organization: instance.policy.organizationName };
    if (needsCli(instance)) return query ? null : { kind: "setUp" };
    const { signedOut, own, all } = models.get(instance.instanceId)!;
    if (all.length === 0) return query ? null : signedOut ? { kind: "signIn" } : { kind: "empty", loading: input.refreshing === instance.instanceId };
    const currentSelection = instance.instanceId === selection.instanceId ? selection : undefined;
    const repeated = repeatedModelLabels(all);
    const botSelection = bot.follows === false && bot.selection.instanceId === instance.instanceId ? bot.selection : undefined;
    const row = (option: ModelChoice): MenuModelRow => ({
      option,
      ...(option.nativeModel ? { model: option.nativeModel } : {}),
      ...(option.variant ? { variant: option.variant } : {}),
      label: shortModelLabel(option.label, provider),
      ...(repeated.has(option.label) && option.provider ? { route: option.provider } : {}),
      current: currentSelection ? choiceIsSelected(option, currentSelection) : false,
    });
    const mixed = own.length > 0 && own.length < all.length;
    if (query) {
      const rows = filterCustomModels(all, query).map(row);
      return rows.length === 0 ? null
        : { kind: "models", rows, total: all.length, toggle: null, localFrom: localFrom(rows, mixed), signInForOwn: false, probing: false };
    }
    const others = all.filter((option) => (!currentSelection || !choiceIsSelected(option, currentSelection))
      && (!botSelection || !choiceIsSelected(option, botSelection)));
    const suggested = suggestedModels(others, instance.models.default, undefined,
      currentSelection === undefined ? GROUP_SUGGESTIONS : CURRENT_GROUP_SUGGESTIONS);
    const rest = others.filter((option) => !suggested.includes(option));
    const open = expanded.has(instance.instanceId) || rest.length === 1;
    const rows = (open ? [...suggested, ...rest] : suggested).map(row);
    const looking = probing.has(instance.instanceId) && own.length === all.length;
    if (rows.length === 0 && !signedOut && !looking) return null;
    return {
      kind: "models", rows, total: all.length,
      toggle: rest.length > 1 ? (expanded.has(instance.instanceId) ? "less" : "more") : null,
      localFrom: localFrom(rows, mixed), signInForOwn: signedOut, probing: looking,
    };
  }

  const groups = (current ? [current, ...ordered.filter((instance) => instance !== current)] : ordered).flatMap((instance): MenuGroup[] => {
    const named = heading(instance, listed);
    const body = groupBody(instance, named.provider);
    return body ? [{ instance, ...named, body }] : [];
  });

  return {
    current: query ? null : currentRow(input),
    follow: !query && bot.follows === false,
    groups,
    search,
    query,
    results: query ? groups.reduce((sum, group) => sum + (group.body.kind === "models" ? group.body.rows.length : 0), 0) : null,
    empty: listed.length > 0 ? null : input.loading ? "loading" : "none",
    busy: input.loading || input.refreshing != null,
  };
}
