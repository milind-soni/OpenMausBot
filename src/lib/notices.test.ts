import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { withTourReset } from "@/lib/guided-tour";
import { DESKTOP_NOTICES } from "../../electron/desktop-prefs.mjs";
import { ANNOUNCEMENT_NOTICE, BOAT_OFFER_NOTICE, CLOUD_INTRO, CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, dismissNotices, FOLLOWERS, GROK_MOVE_NOTICE, introShown, introStage, launchNotice, localDay, markLaunchNotice, MODELGO_OFFER_NOTICE, MUST_ACT,
  nextNotice, noticeSeen, NOTICES, OLD_PRO_DISMISSALS, PHONE_UPDATE_NOTICE, phoneUpdateHint, PRODUCT_HUNT_NOTICE, SIMPLE_MODE_NOTICE, STAR_NOTICE, TWO_PLACES_NOTICE, UPDATES_CONSENT_NOTICE, usedBefore, WHATS_NEW_NOTICE, type NoticeFacts,
  type NoticeId } from "./notices";

let storage: Map<string, string>, session: Map<string, string>;
beforeEach(() => {
  storage = new Map(); session = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const facts = (intro: boolean | null, trial: boolean | null, cloud: boolean | null, star: boolean | null, launch: boolean | null = false, popup: boolean | null = false,
  consent: boolean | null = false, simple: boolean | null = false, boat: boolean | null = false, two: boolean | null = false, grok: boolean | null = false, modelgo: boolean | null = false,
  phone: boolean | null = false, announcement: boolean | null = false): NoticeFacts =>
  ({ [GROK_MOVE_NOTICE]: grok, [PHONE_UPDATE_NOTICE]: phone, [SIMPLE_MODE_NOTICE]: simple, [WHATS_NEW_NOTICE]: popup, [UPDATES_CONSENT_NOTICE]: consent, [TWO_PLACES_NOTICE]: two, [PRODUCT_HUNT_NOTICE]: launch, [CLOUD_INTRO]: intro, [CLOUD_TRIAL_NOTICE]: trial, [CLOUD_NOTICE]: cloud,
    [MODELGO_OFFER_NOTICE]: modelgo, [BOAT_OFFER_NOTICE]: boat, [ANNOUNCEMENT_NOTICE]: announcement, [STAR_NOTICE]: star });
const none = () => false;
const DAY = 86_400_000, NOON = new Date(2026, 9, 9, 12).getTime();

it("the Move from Grok Bot popup goes ahead of everything, and holds the queue while it waits", () => {
  const all = (grok: boolean | null) => facts(true, true, true, true, true, true, true, true, true, true, grok);
  expect(nextNotice(all(true), none)).toBe(GROK_MOVE_NOTICE);
  expect(nextNotice(all(null), none)).toBeNull();
  expect(nextNotice(all(false), none)).toBe(SIMPLE_MODE_NOTICE);
  expect(nextNotice(all(true), none, WHATS_NEW_NOTICE), "not in a launch another notice took").toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(all(true), none, GROK_MOVE_NOTICE), "a reload of the launch it took").toBe(GROK_MOVE_NOTICE);
  expect(GROK_MOVE_NOTICE).toBe("grok-move-2026-11");
});

it("is one queue: the Simple mode popup first, then What's new, the product-updates question, the launch card, the card after the update, the trial's notice, the My Cloud card, Boat's credit offer, the star", () => {
  expect(nextNotice(facts(true, true, true, true, true, true, true, true), none)).toBe(SIMPLE_MODE_NOTICE);
  expect(nextNotice(facts(true, true, true, true, true, true, true, null), none), "nothing shows while the Simple mode popup waits").toBeNull();
  expect(nextNotice(facts(true, true, true, true, true, true, true, true), id => id === SIMPLE_MODE_NOTICE)).toBe(WHATS_NEW_NOTICE);
  expect(NOTICES).toEqual([GROK_MOVE_NOTICE, PHONE_UPDATE_NOTICE, SIMPLE_MODE_NOTICE, WHATS_NEW_NOTICE, UPDATES_CONSENT_NOTICE, TWO_PLACES_NOTICE, PRODUCT_HUNT_NOTICE, CLOUD_INTRO, CLOUD_TRIAL_NOTICE, CLOUD_NOTICE, MODELGO_OFFER_NOTICE, BOAT_OFFER_NOTICE, ANNOUNCEMENT_NOTICE, STAR_NOTICE]);
  expect(nextNotice(facts(true, true, true, true, true, false, false, false, false, true), none), "bots in two places come before any promotion").toBe(TWO_PLACES_NOTICE);
  expect(nextNotice(facts(true, true, true, true, true, false, true, false, false, true), none), "after the product-updates question").toBe(UPDATES_CONSENT_NOTICE);
  expect(nextNotice(facts(true, true, true, true, true, false, false, false, false, null), none), "nothing lower shows while main hasn't answered").toBeNull();
  expect(nextNotice(facts(true, true, true, true, true, true, true), none)).toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(facts(true, true, true, true, true, true, true), id => id === WHATS_NEW_NOTICE)).toBe(UPDATES_CONSENT_NOTICE);
  expect(nextNotice(facts(true, true, true, true, true, null, true), none)).toBeNull();
  expect(nextNotice(facts(true, true, true, true, true, false, null), none)).toBeNull();
  expect(WHATS_NEW_NOTICE).toBe("whats-new-2026-11");
  expect(nextNotice(facts(true, true, true, true, true, true), none)).toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(facts(true, true, true, true, true, null), none)).toBeNull();
  expect(nextNotice(facts(true, true, true, true, true, true), id => id === WHATS_NEW_NOTICE)).toBe(PRODUCT_HUNT_NOTICE);
  expect(nextNotice(facts(true, true, true, true, true), none)).toBe(PRODUCT_HUNT_NOTICE);
  expect(nextNotice(facts(true, true, true, true, null), none)).toBeNull();
  expect(nextNotice(facts(true, true, true, true, true), id => id === PRODUCT_HUNT_NOTICE)).toBe(CLOUD_INTRO);
  expect(CLOUD_INTRO).toBe("cloud-trial-intro-v1");
  expect(nextNotice(facts(true, true, true, true), none)).toBe(CLOUD_INTRO);
  expect(nextNotice(facts(false, true, true, true), none)).toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(facts(false, false, true, true), none)).toBe(CLOUD_NOTICE);
  expect(nextNotice(facts(false, false, false, true), none)).toBe(STAR_NOTICE);
  const boat = (intro: boolean, trial: boolean, cloud: boolean, offer: boolean | null) => facts(intro, trial, cloud, true, false, false, false, false, offer);
  expect(nextNotice(boat(false, false, false, true), none)).toBe(BOAT_OFFER_NOTICE);
  expect(nextNotice(boat(false, true, false, true), none), "a trial's notice goes first").toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(boat(false, false, true, true), none), "so does the account's card").toBe(CLOUD_NOTICE);
  expect(nextNotice(boat(false, false, false, null), none), "the star waits for it").toBeNull();
  expect(nextNotice(boat(false, false, false, true), id => id === BOAT_OFFER_NOTICE)).toBe(STAR_NOTICE);
  expect(nextNotice(facts(true, true, true, true), id => id === CLOUD_INTRO || id === STAR_NOTICE)).toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(facts(true, true, true, true), () => true)).toBeNull();
  expect(nextNotice(facts(false, false, false, false), none)).toBeNull();
});

it("Boat's credit offer and the Grok Bot move are ones the desktop keeps for its every page, as What's new is", () => {
  expect(DESKTOP_NOTICES).toEqual([WHATS_NEW_NOTICE, BOAT_OFFER_NOTICE, GROK_MOVE_NOTICE, MODELGO_OFFER_NOTICE]);
});

it("one notice a launch: What's new goes first and Boat's credit offer waits for a later launch; only the product-updates question may follow", () => {
  const both = facts(false, false, false, true, false, true, false, false, true);
  expect(nextNotice(both, none)).toBe(WHATS_NEW_NOTICE);
  expect(NOTICES.indexOf(WHATS_NEW_NOTICE), "What's new comes before the Boat card").toBeLessThan(NOTICES.indexOf(BOAT_OFFER_NOTICE));
  expect(nextNotice(both, id => id === WHATS_NEW_NOTICE, WHATS_NEW_NOTICE), "What's new closed: nothing else this launch").toBeNull();
  expect(nextNotice(facts(false, false, false, true, false, true, true, false, true), id => id === WHATS_NEW_NOTICE, WHATS_NEW_NOTICE), "but the question may follow")
    .toBe(UPDATES_CONSENT_NOTICE);
  expect(nextNotice(both, none, WHATS_NEW_NOTICE), "a reload while it is up shows it again").toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(both, id => id === WHATS_NEW_NOTICE), "the next launch").toBe(BOAT_OFFER_NOTICE);
  expect(nextNotice(facts(false, null, false, true, false, false, false, false, true), none, BOAT_OFFER_NOTICE), "a notice this launch didn't take never holds it back")
    .toBe(BOAT_OFFER_NOTICE);
  expect(nextNotice(facts(false, true, false, true), none, BOAT_OFFER_NOTICE), "a trial's notice waits for the next launch too").toBeNull();
});

it("a launch keeps the notice it showed first for the window's session; storage that throws keeps it for the page", () => {
  expect(launchNotice()).toBeNull();
  markLaunchNotice(WHATS_NEW_NOTICE); markLaunchNotice(BOAT_OFFER_NOTICE);
  expect(launchNotice()).toBe(WHATS_NEW_NOTICE);
  expect(session.get("omb.launch.notice")).toBe(WHATS_NEW_NOTICE);
  session.set("omb.launch.notice", "something-else");
  expect(launchNotice(), "only a notice of the list").toBeNull();
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  markLaunchNotice(STAR_NOTICE);
  expect(launchNotice()).toBe(STAR_NOTICE);
});

it("waits while an earlier notice's answer is unknown, so a later one never shows first", () => {
  expect(nextNotice(facts(null, false, false, true), none)).toBeNull();
  expect(nextNotice(facts(false, null, false, true), none)).toBeNull();
  expect(nextNotice(facts(null, false, false, true), id => id === CLOUD_INTRO)).toBe(STAR_NOTICE);
});

it("a dismissal holds on this device at once and in the workspace record for good", () => {
  const seen = record(["tour.done"]);
  expect(dismissNotice(seen, STAR_NOTICE)).toEqual({ onboarding: { hintsSeen: ["tour.done", STAR_NOTICE] } });
  expect(storage.get(STAR_NOTICE)).toBe("1");
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(true);
  storage.clear();
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(false);
  expect(noticeSeen(record([STAR_NOTICE]), STAR_NOTICE)).toBe(true);
  expect(dismissNotice(record([STAR_NOTICE]), STAR_NOTICE)).toBeNull();
  expect(withTourReset(record([CLOUD_INTRO, `${CLOUD_INTRO}:day-2`, STAR_NOTICE, "tour.done"]))).toEqual([CLOUD_INTRO, `${CLOUD_INTRO}:day-2`, STAR_NOTICE]);
});

it("browser storage that throws still leaves the workspace record in charge", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(false);
  expect(noticeSeen(record([STAR_NOTICE]), STAR_NOTICE)).toBe(true);
  expect(dismissNotice(record(), STAR_NOTICE)).toEqual({ onboarding: { hintsSeen: [STAR_NOTICE] } });
  expect(introStage(record(), NOON)).toBe("due");
  expect(introShown(record(), NOON)).toEqual({ onboarding: { hintsSeen: [`${CLOUD_INTRO}:day-1`] } });
});

it("the card after the update shows at most once a calendar day, on at most three days, then counts as dismissed", () => {
  let hints: string[] = [];
  const show = (at: number) => { const patch = introShown(record(hints), at); if (patch) hints = patch.onboarding.hintsSeen; };
  expect(introStage(record(hints), NOON)).toBe("due");
  show(NOON);
  expect(hints).toEqual([`${CLOUD_INTRO}:day-1`]);
  expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOON)]);
  expect(introStage(record(hints), NOON + 3 * 3600_000)).toBe("shown-today");
  expect(introShown(record(hints), NOON + 3 * 3600_000)).toBeNull();
  const midnight = new Date(2026, 9, 10, 0, 30).getTime();
  expect(introStage(record(hints), midnight)).toBe("due");
  show(midnight); show(NOON + 5 * DAY);
  expect(hints).toEqual([`${CLOUD_INTRO}:day-1`, `${CLOUD_INTRO}:day-2`, `${CLOUD_INTRO}:day-3`]);
  expect(introStage(record(hints), NOON + 5 * DAY + 3600_000)).toBe("shown-today");
  expect(introStage(record(hints), NOON + 6 * DAY)).toBe("done");
  storage.clear();
  expect(introStage(record(hints), NOON + 6 * DAY)).toBe("done");
  expect(introStage(record([`${CLOUD_INTRO}:day-3`]), NOON + 6 * DAY)).toBe("done");
  expect(introStage(record([`${CLOUD_INTRO}:day-2`]), NOON + 6 * DAY)).toBe("due");
  expect(introStage(record([CLOUD_INTRO]), NOON)).toBe("done");
  storage.set(CLOUD_INTRO, "1");
  expect(introStage(record(), NOON)).toBe("done");
});

it("someone who closed the earlier Pro card sees this one on one day only", () => {
  expect([...OLD_PRO_DISMISSALS]).toEqual(["pro-introduction-dismissed-v2", "pro-introduction-dismissed-v3"]);
  for (const earlier of OLD_PRO_DISMISSALS) {
    storage.clear();
    expect(introStage(record([earlier]), NOON)).toBe("due");
    const patch = introShown(record([earlier]), NOON)!;
    expect(introStage({ ...record(), hintsSeen: patch.onboarding.hintsSeen }, NOON + DAY)).toBe("done");
    storage.clear(); storage.set(earlier, "1");
    introShown(record(), NOON);
    expect(introStage(record(), NOON + DAY)).toBe("done");
  }
  storage.clear();
  introShown(record(["pro-introduction-dismissed"]), NOON);
  expect(introStage(record(["pro-introduction-dismissed"]), NOON + DAY)).toBe("due");
});

it("someone has used the app before when a conversation from before this launch has had a reply", () => {
  const launch = 1_000_000;
  const task = (createdAt: number, turns?: number) => ({ createdAt, ...(turns === undefined ? {} : { usage: { turns } }) });
  expect(usedBefore([], launch)).toBe(false);
  expect(usedBefore([{ tasks: [task(launch - 1, 1)] }], launch)).toBe(true);
  expect(usedBefore([{ tasks: [task(launch, 3)] }], launch)).toBe(false);
  expect(usedBefore([{ tasks: [task(launch - 1, 0), task(launch - 1)] }, {}], launch)).toBe(false);
  expect(usedBefore([{}, { tasks: [task(launch + 5, 2), task(launch - 9, 2)] }], launch)).toBe(true);
});

it("ModelGo's card follows update consent and the account's notices, and goes before every other promotion after them", () => {
  const modelgo = ({ consent = false, trial = false, cloud = false, offer = true, boat = true }: { consent?: boolean | null; trial?: boolean | null; cloud?: boolean | null; offer?: boolean | null; boat?: boolean | null }) =>
    facts(false, trial, cloud, true, false, false, consent, false, boat, false, false, offer);
  expect(nextNotice(modelgo({}), none)).toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice(modelgo({ consent: true }), none), "the product-updates question goes first").toBe(UPDATES_CONSENT_NOTICE);
  expect(nextNotice(modelgo({ consent: null }), none), "and holds it while main hasn't answered").toBeNull();
  expect(nextNotice(modelgo({ trial: true }), none), "a trial's notice goes first").toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(modelgo({ cloud: true }), none), "so does the account's card").toBe(CLOUD_NOTICE);
  expect(nextNotice(modelgo({ offer: null }), none), "Boat and the star wait for it").toBeNull();
  expect(nextNotice(modelgo({}), id => id === MODELGO_OFFER_NOTICE), "seen once, then Boat").toBe(BOAT_OFFER_NOTICE);
  expect(MODELGO_OFFER_NOTICE).toBe("modelgo-offer-2026-11");
});

it("Update MausBot on your phone goes right after the Grok Bot popup, ahead of every promotion, and holds the sponsor's card", () => {
  const all = (phone: boolean | null, grok: boolean | null = false) => facts(true, true, true, true, true, true, true, true, true, true, grok, true, phone);
  expect(nextNotice(all(true), none)).toBe(PHONE_UPDATE_NOTICE);
  expect(nextNotice(all(true, true), none), "the Grok Bot popup still goes first").toBe(GROK_MOVE_NOTICE);
  expect(nextNotice(all(null), none), "nothing lower while it is unknown").toBeNull();
  expect(nextNotice(all(false), none)).toBe(SIMPLE_MODE_NOTICE);
  const sponsor = facts(false, false, false, true, false, false, false, false, true, false, false, true, true);
  expect(nextNotice(sponsor, none), "ahead of ModelGo, Boat and the star").toBe(PHONE_UPDATE_NOTICE);
  expect(nextNotice(sponsor, none, WHATS_NEW_NOTICE, true), "left for a later launch, it still holds the sponsor's card back").toBeNull();
  expect(nextNotice(sponsor, none, PHONE_UPDATE_NOTICE, true), "closed in its own launch: the card follows").toBe(MODELGO_OFFER_NOTICE);
});

it("an Update MausBot on your phone dismissal is kept per phone, in short hints, all in one patch", () => {
  expect(phoneUpdateHint("0f8c2a41-1111-4222-8333-444455556666")).toBe("phone-app-update:0f8c2a41");
  expect(phoneUpdateHint("0f8c2a41-1111-4222-8333-444455556666").length).toBeLessThanOrEqual(60);
  const ids = [phoneUpdateHint("aaaaaaaa-1"), phoneUpdateHint("bbbbbbbb-2")];
  expect(dismissNotices(record(["star"]), ids)).toEqual({ onboarding: { hintsSeen: ["star", ...ids] } });
  for (const id of ids) expect(noticeSeen(undefined, id)).toBe(true);
  expect(dismissNotices(record(ids), ids), "nothing new").toBeNull();
  expect(dismissNotices(record([ids[0]!]), [...ids, ids[1]!])).toEqual({ onboarding: { hintsSeen: ids } });
});

it("ModelGo's card follows the launch's notice in the same launch once it is closed, after the question, never ahead of a notice to act on", () => {
  expect([...FOLLOWERS]).toEqual([UPDATES_CONSENT_NOTICE, MODELGO_OFFER_NOTICE, ANNOUNCEMENT_NOTICE]);
  expect([...MUST_ACT]).toEqual([GROK_MOVE_NOTICE, PHONE_UPDATE_NOTICE, CLOUD_TRIAL_NOTICE, CLOUD_NOTICE]);
  const due = ({ popup = true, consent = false, trial = false, cloud = false, grok = false, intro = false, two = false }: Partial<Record<"popup" | "trial" | "cloud" | "grok" | "intro" | "two", boolean | null>> & { consent?: boolean | null }) =>
    facts(intro, trial, cloud, true, false, popup, consent, false, true, two, grok, true);
  const popupSeen = (id: NoticeId) => id === WHATS_NEW_NOTICE;
  expect(nextNotice(due({}), none), "What's new goes first").toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(due({}), none, WHATS_NEW_NOTICE), "a reload while it is up").toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(due({}), popupSeen, WHATS_NEW_NOTICE, true), "closed: the card follows").toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice(due({ popup: false }), none, WHATS_NEW_NOTICE), "and after a reload").toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice(due({}), id => id === WHATS_NEW_NOTICE || id === MODELGO_OFFER_NOTICE, WHATS_NEW_NOTICE, true), "once: Boat still waits").toBeNull();
  expect(nextNotice(due({ consent: true }), popupSeen, WHATS_NEW_NOTICE, true), "the question goes first").toBe(UPDATES_CONSENT_NOTICE);
  expect(nextNotice(due({ consent: null }), popupSeen, WHATS_NEW_NOTICE, true), "and holds it while unanswered").toBeNull();
  expect(nextNotice(due({ intro: true, two: true }), popupSeen, WHATS_NEW_NOTICE, true), "promotions left for later don't hold it").toBe(MODELGO_OFFER_NOTICE);
  for (const [name, held] of [["grok", due({ grok: true })], ["trial", due({ trial: true })], ["cloud", due({ cloud: true })], ["trial unknown", due({ trial: null })]] as const)
    expect(nextNotice(held, popupSeen, WHATS_NEW_NOTICE, true), `${name}: it waits for that notice's launch`).toBeNull();
  expect(nextNotice(due({ popup: false, trial: true }), none), "that launch: the trial's notice first").toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(due({ popup: false, trial: true }), none, CLOUD_TRIAL_NOTICE), "while it is up").toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(due({ popup: false, trial: true }), none, CLOUD_TRIAL_NOTICE, true), "closed, its facts unchanged: the card follows").toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice(due({ popup: false, grok: true }), none, GROK_MOVE_NOTICE, true), "after the move popup too").toBe(MODELGO_OFFER_NOTICE);
  const star = facts(false, false, false, true, false, false, false, false, false, false, false, true);
  expect(nextNotice(star, none, STAR_NOTICE), "a card still up keeps the corner").toBe(STAR_NOTICE);
  expect(nextNotice(star, id => id === STAR_NOTICE, STAR_NOTICE, true), "then the card").toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice(due({ popup: false, trial: true }), none, MODELGO_OFFER_NOTICE), "a notice due later never takes the card's own launch from it").toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice(due({ popup: false }), none, null, true), "a closed notice with no launch kept: the card, and nothing else").toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice({ ...due({}), [MODELGO_OFFER_NOTICE]: false }, popupSeen, WHATS_NEW_NOTICE, true), "where it may not show: nothing").toBeNull();
  expect(nextNotice({ ...due({}), [MODELGO_OFFER_NOTICE]: null }, popupSeen, WHATS_NEW_NOTICE, true), "while unknown: nothing yet").toBeNull();
});

it("a card from the announcements file comes after every notice someone must act on and every built-in offer, before the star", () => {
  const remote = ({ consent = false, trial = false, cloud = false, modelgo = false, boat = false, card = true, popup = false, grok = false, phone = false }: { consent?: boolean | null;
    trial?: boolean | null; cloud?: boolean | null; modelgo?: boolean | null; boat?: boolean | null; card?: boolean | null; popup?: boolean | null; grok?: boolean | null; phone?: boolean | null }) =>
    facts(false, trial, cloud, true, false, popup, consent, false, boat, false, grok, modelgo, phone, card);
  expect(nextNotice(remote({}), none)).toBe(ANNOUNCEMENT_NOTICE);
  for (const [first, id] of [[{ phone: true }, PHONE_UPDATE_NOTICE], [{ consent: true }, UPDATES_CONSENT_NOTICE], [{ trial: true }, CLOUD_TRIAL_NOTICE], [{ cloud: true }, CLOUD_NOTICE],
    [{ modelgo: true }, MODELGO_OFFER_NOTICE], [{ boat: true }, BOAT_OFFER_NOTICE]] as const) expect(nextNotice(remote(first), none), id).toBe(id);
  expect(nextNotice(remote({ card: null }), none), "the star waits while it is undecided").toBeNull();
  expect(nextNotice(remote({ card: false }), none)).toBe(STAR_NOTICE);
  expect(nextNotice(remote({ boat: true }), none, BOAT_OFFER_NOTICE), "never over a card still up").toBe(BOAT_OFFER_NOTICE);
  expect(nextNotice(remote({ boat: true }), id => id === BOAT_OFFER_NOTICE, BOAT_OFFER_NOTICE, true), "it follows that card once it is closed").toBe(ANNOUNCEMENT_NOTICE);
});

it("a card from the announcements file follows the launch's notice in the same launch, after the question and the sponsor's card, never ahead of a notice to act on", () => {
  const remote = (extra: Partial<Record<"popup" | "consent" | "modelgo" | "boat" | "trial" | "cloud" | "grok" | "phone" | "card", boolean | null>> = {}) => {
    const { popup = true, consent = false, modelgo = false, boat = false, trial = false, cloud = false, grok = false, phone = false, card = true } = extra;
    return facts(false, trial, cloud, true, false, popup, consent, false, boat, false, grok, modelgo, phone, card);
  };
  const popupSeen = (id: NoticeId) => id === WHATS_NEW_NOTICE;
  expect(nextNotice(remote(), none), "What's new goes first").toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(remote(), none, WHATS_NEW_NOTICE), "never over it while it is up").toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(remote(), popupSeen, WHATS_NEW_NOTICE, true), "follows a closed What's new").toBe(ANNOUNCEMENT_NOTICE);
  expect(nextNotice(remote({ popup: false }), none, WHATS_NEW_NOTICE), "and after a reload").toBe(ANNOUNCEMENT_NOTICE);
  expect(nextNotice(remote({ consent: true }), popupSeen, WHATS_NEW_NOTICE, true), "the product-updates question first").toBe(UPDATES_CONSENT_NOTICE);
  expect(nextNotice(remote({ consent: null }), popupSeen, WHATS_NEW_NOTICE, true), "which holds it while unanswered").toBeNull();
  expect(nextNotice(remote({ modelgo: true }), popupSeen, WHATS_NEW_NOTICE, true), "then the sponsor's card").toBe(MODELGO_OFFER_NOTICE);
  expect(nextNotice(remote({ modelgo: null }), popupSeen, WHATS_NEW_NOTICE, true), "which holds it while undecided").toBeNull();
  expect(nextNotice(remote({ modelgo: true }), id => id === WHATS_NEW_NOTICE || id === MODELGO_OFFER_NOTICE, WHATS_NEW_NOTICE, true), "then the announcement").toBe(ANNOUNCEMENT_NOTICE);
  expect(nextNotice(remote({ boat: true }), popupSeen, WHATS_NEW_NOTICE, true), "Boat's offer is no follower: it waits, the announcement does not").toBe(ANNOUNCEMENT_NOTICE);
  for (const [name, held] of [["grok", remote({ grok: true })], ["phone", remote({ phone: true })], ["trial", remote({ trial: true })], ["cloud", remote({ cloud: true })], ["trial unknown", remote({ trial: null })]] as const)
    expect(nextNotice(held, popupSeen, WHATS_NEW_NOTICE, true), `${name}: held for that notice's launch`).toBeNull();
  expect(nextNotice(remote({ popup: false, trial: true }), none, CLOUD_TRIAL_NOTICE, true), "and follows it there").toBe(ANNOUNCEMENT_NOTICE);
  expect(nextNotice(remote({ card: false }), popupSeen, WHATS_NEW_NOTICE, true), "none due (one a launch, a sponsor a week): nothing").toBeNull();
});
