import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../../electron/cloud-account.mjs";
import { announcementHistory, announcementsUnread, markAnnouncementsRead, useAnnouncementRecord, type HistoryFacts, type HistoryItem, type PersonRecord,
  type RecordWriter } from "@/lib/announcement-history";
import { announcementConditions, announcementFeedUpdatedAt, announcementPlan, announcementPlatform, announcementSurface, cardsForPerson, providersRestricted,
  SPONSOR_CARDS_FOR_TEAM_MEMBERS, useAnnouncementCards } from "@/lib/announcements";
import { appVersion } from "@/lib/app-links";
import { brandStatus } from "@/lib/brand";
import { cloudPlanView } from "@/lib/cloud-plan";
import { activeLocale } from "@/lib/i18n";
import { modelgoOfferable } from "@/lib/modelgo-offer";
import { usedBefore } from "@/lib/notices";
import type { WelcomeViewer } from "@/lib/onboarding";
import { useStore } from "@/state/store";
import { useDesktopNotices } from "../desktop-notices";
import { localDesktopPage, useWelcomeViewer } from "../onboarding/WelcomeGate";

/** An organization runs this desktop: null while main answers; false in a browser. */
function useOrganization(): boolean | null {
  const [organization, setOrganization] = useState<boolean | null>(window.ogb?.organization ? null : false);
  useEffect(() => {
    const org = window.ogb?.organization;
    if (!org) return;
    let active = true;
    const read = (next: { status: string; organization?: unknown }) => { if (active) setOrganization(next.status !== "signed-out" && Boolean(next.organization)); };
    const unsubscribe = org.onState(read);
    void org.state().then(read, () => { if (active) setOrganization(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  return organization;
}

function useCloudAccount(bridge: NonNullable<Window["ogb"]>["cloudAccount"]): CloudAccountState | null {
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onState(next => { if (active) setAccount(next); });
    void bridge.state().then(next => { if (active) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return account;
}

export interface Announcements {
  items: HistoryItem[];
  /** The red dot: false until everything it depends on has loaded. */
  unread: boolean;
  markRead: () => void;
  person: PersonRecord;
  writer: RecordWriter;
  viewer: WelcomeViewer | null;
  /** This desktop's MausBot Cloud sign-in, on its own page. */
  account: CloudAccountState | null;
  /** The app's Add a Cloud and Cloud sign-in are here: This computer's page. */
  cloudBridge: boolean;
}

/** Every announcement this person could have had here, and whether one is new to them. */
export function useAnnouncements(now: () => number = Date.now): Announcements {
  const { state, dispatch } = useStore();
  useAnnouncementRecord();
  const viewer = useWelcomeViewer();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  const organization = useOrganization();
  const account = useCloudAccount(bridge);
  const branded = brandStatus().source === "file";
  const team = Boolean(state.config?.team);
  const canSave = viewer?.canSave !== false;
  const cloudHome = Boolean(state.config?.cloudHome || viewer?.cloudHome);
  const sponsors = SPONSOR_CARDS_FOR_TEAM_MEMBERS || !team || viewer?.canSave === true;
  const facts: HistoryFacts = {
    branded, organization, remote, team, canSave, sponsors,
    cloudSale: Boolean(bridge && desktop), cloudCards: Boolean(bridge || (!remote && cloudHome && window.ogb?.cloudPlan)),
    modelgo: modelgoOfferable(state.config?.managedPolicy),
  };
  const surface = announcementSurface(local, cloudHome);
  const cards = cardsForPerson(useAnnouncementCards(!branded), {
    facts: { nowMs: now(), version: appVersion(), platform: announcementPlatform(globalThis.navigator?.userAgent), surface,
      plan: announcementPlan(surface, bridge ? cloudPlanView(account) : null, team), people: usedBefore(state.bots) ? "existing" : "new", locale: activeLocale(),
      conditions: announcementConditions(state) },
    branded, admin: canSave, sponsors: !providersRestricted(state.config?.managedPolicy) && sponsors,
  });
  const items = announcementHistory({ facts, cards, feedUpdatedAt: announcementFeedUpdatedAt(), now: now() });
  const record = state.config?.onboarding;
  const person: PersonRecord = { record, desktopSeen: desktopState?.seen ?? [] };
  const ready = viewer !== null && organization !== null && (!desktop || desktopState !== null) && state.config !== null;
  const writer: RecordWriter = { team, desktop, saved: config => dispatch({ type: "configStatus", config }) };
  return {
    items, unread: ready && announcementsUnread(items, person), person, writer, viewer, account, cloudBridge: Boolean(bridge),
    markRead: () => markAnnouncementsRead(now(), record, writer),
  };
}
