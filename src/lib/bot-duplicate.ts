// A copy's restrictions go in the request that creates it: a later patch that failed would leave it unrestricted.
import { helperModelAllowed } from "../../shared/wire";
import type { Bot } from "@/state/store";

export type RestrictedSource = Pick<Bot, "visibility" | "toolScope" | "helperModel">;

export interface RestrictedCopyRequest {
  visibility?: Bot["visibility"];
  settings?: { toolScope?: Bot["toolScope"]; helperModel?: false };
}

export function restrictedCopyRequest(source: RestrictedSource): RestrictedCopyRequest {
  const settings: NonNullable<RestrictedCopyRequest["settings"]> = {
    ...(Object.hasOwn(source, "toolScope") ? { toolScope: source.toolScope } : {}),
    ...(helperModelAllowed(source) ? {} : { helperModel: false as const }),
  };
  return {
    ...(source.visibility && source.visibility !== "everyone" ? { visibility: source.visibility } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
}

/** What a copy takes from its source, PATCHed onto the new bot in one request. A copy of a VPS bot keeps its server. */
export function duplicateBotProfile(source: Bot) {
  return {
    name: `${source.name} copy`,
    title: source.title,
    description: source.description,
    soul: source.soul,
    notifications: source.notifications,
    modelSelection: source.modelSelection,
    computer: source.computer,
    cloudBackend: source.cloudBackend,
    autoStartVps: source.autoStartVps,
    vpsAlias: source.vpsAlias,
    avatarUrl: source.avatarUrl,
    avatarCrop: source.avatarCrop,
    avatarZoom: source.avatarZoom,
    avatarFocusX: source.avatarFocusX,
    avatarFocusY: source.avatarFocusY,
  };
}
