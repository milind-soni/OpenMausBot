import type { CloudOffer, CloudOfferPlan } from "../../electron/cloud-home.mjs";
import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import type { AddCloudView } from "../../electron/cloud-rail.mjs";
import type { CloudColor } from "../../electron/cloud-buy.mjs";
import type { LocaleKey } from "@/locales";
import { cloudColorFill } from "@/lib/cloud-look";
import { CHECKOUT_WAIT_MS } from "@/lib/cloud-plan";

/** A Cloud's name as the Admin keeps it: up to 40 characters. */
export const CLOUD_LIST_NAME_LIMIT = 40;
/** The colour each Admin swatch is drawn in here (electron/cloud-list.mjs CLOUD_SWATCH_COLORS); slate is the plain one. */
export const SWATCH_COLOR = { blue: "blue", green: "teal", amber: "yellow", rose: "red", violet: "purple", slate: null } as const satisfies Record<CloudSwatch, CloudColor | null>;
export function swatchFill(swatch: CloudSwatch): string {
  const color = SWATCH_COLOR[swatch];
  return color ? cloudColorFill(color) : "var(--color-raised)";
}

/** The Admin's swatches in the order the sheet offers them, each with the name of the colour this app draws it in. */
export const CLOUD_SWATCH_LABEL = {
  blue: "cloudBuy.color.blue", green: "cloudBuy.color.teal", amber: "cloudBuy.color.yellow", rose: "cloudBuy.color.red", violet: "cloudBuy.color.purple", slate: "cloudBuy.color.slate",
} as const satisfies Record<CloudSwatch, LocaleKey>;
export const CLOUD_SWATCH_ORDER = Object.keys(CLOUD_SWATCH_LABEL) as CloudSwatch[];
export const DEFAULT_SWATCH: CloudSwatch = "blue";

type Adding = Extract<AddCloudView, { signedIn: true }>["adding"] & {};
/** Why the sheet can't sell another Cloud now: one Cloud per account (an older Admin, or its cap), new Clouds closed,
 * another one's checkout still open, or too many checkouts at once. */
export type AddCloudStop = "one" | "signups_closed" | "checkout_open" | "rate";

/** Each screen of buying another Cloud, from the sheet's own steps and the Admin's word, which wins: a Cloud being bought
 * shows how it is going until it was opened. */
export type AddCloudScreen =
  | { kind: "checking" }
  | { kind: "first" }
  | { kind: "stop"; reason: AddCloudStop; home: string | null }
  | { kind: "unreachable" }
  | { kind: "error" }
  | { kind: "choose"; offer: CloudOffer }
  | { kind: "name"; plan: CloudOfferPlan }
  | { kind: "waiting"; adding: Adding; late: boolean }
  | { kind: "starting"; adding: Adding }
  | { kind: "ready"; adding: Adding }
  | { kind: "problem"; adding: Adding };

export function addCloudScreen(view: AddCloudView | null | undefined, { now, tier = null, failed = false, stop = null }: {
  now: number; tier?: string | null; failed?: boolean; stop?: AddCloudStop | null;
}): AddCloudScreen {
  if (view === undefined) return { kind: "checking" };
  if (view === null) return { kind: "unreachable" };
  if (!view.signedIn || !view.hasCloud) return { kind: "first" };
  const adding = view.adding && !view.adding.done ? view.adding : null;
  if (adding) {
    if (adding.status === "ready") return { kind: "ready", adding };
    if (adding.status === "setting_up") return { kind: "starting", adding };
    if (adding.status === "problem") return { kind: "problem", adding };
    return { kind: "waiting", adding, late: now - adding.startedAt >= CHECKOUT_WAIT_MS };
  }
  const home = view.home?.name ?? null;
  if (!view.supported) return { kind: "stop", reason: "one", home };
  const blocked = stop ?? (view.canAdd ? null : view.blocked === "cap" || !view.blocked ? "one" : view.blocked);
  if (blocked) return { kind: "stop", reason: blocked, home };
  if (failed) return { kind: "error" };
  if (!view.offer?.plans.length) return { kind: "unreachable" };
  const plan = tier ? view.offer.plans.find((entry) => entry.tier === tier) : undefined;
  return plan ? { kind: "name", plan } : { kind: "choose", offer: view.offer };
}

/** The Admin's refusal, in the sheet's words: its cap is one Cloud per account for now. */
export function addCloudStop(blocked: string): AddCloudStop {
  return blocked === "signups_closed" || blocked === "checkout_open" || blocked === "rate" ? blocked : "one";
}

