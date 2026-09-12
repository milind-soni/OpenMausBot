// Watches the selected bot's chat and puts a spotlight on the right control
// at the right moment during the first real turn. The order and the
// once-only rule live in lib/first-conversation.ts; this component only
// observes the store and persists dismissals to the server's hint list.
// It stays quiet until the welcome tour is done, and never shows on a
// paired remote client.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hintSeenPatch, welcomeDue } from "@/lib/onboarding";
import { emailGateDone } from "@/lib/analytics";
import { currentStep } from "@/lib/guided-tour";
import { anchorFor, nextSpotlight, placementFor, tourComplete, type ChatObservation, type SpotlightId } from "@/lib/first-conversation";
import { t } from "@/lib/i18n";
import type { MausState } from "@/lib/mascot";
import { api, useStore, useStreaming } from "@/state/store";
import { Spotlight } from "./Spotlight";

const COPY: Record<SpotlightId, { key: "onboarding.spot.composer" | "onboarding.spot.model" | "onboarding.spot.approval" | "onboarding.spot.connector"; mascot: MausState }> = {
  "spot.composer": { key: "onboarding.spot.composer", mascot: "happy" },
  "spot.model": { key: "onboarding.spot.model", mascot: "curious" },
  "spot.approval": { key: "onboarding.spot.approval", mascot: "suspicious" },
  "spot.connector": { key: "onboarding.spot.connector", mascot: "curious" },
};

export function FirstConversationTour() {
  const { state, dispatch } = useStore();
  const { streaming } = useStreaming();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const record = state.config?.onboarding;
  // the guided tour covers the composer and the model chip; this watcher
  // only explains the two cards that appear on their own
  const [dismissed, setDismissed] = useState<string[]>([]);
  const seen = useMemo(() => [...(record?.hintsSeen ?? []), ...dismissed, "spot.composer", "spot.model"], [record?.hintsSeen, dismissed]);
  const [active, setActive] = useState<SpotlightId | null>(null);
  const [replyFinished, setReplyFinished] = useState(false);
  const sawBusy = useRef(false);

  const bot = state.bots.find((b) => b.id === state.selectedId) ?? null;
  const busy = Boolean(bot?.busy) || Boolean(bot && streaming[bot.threadId]);

  // a reply has finished once the bot was busy and then stopped
  useEffect(() => {
    if (busy) sawBusy.current = true;
    else if (sawBusy.current) setReplyFinished(true);
  }, [busy]);

  const eligible =
    !remoteClient &&
    !state.welcomeOpen &&
    Boolean(record?.completedAt) &&
    currentStep(record) === null &&
    !welcomeDue(state.config, { remoteClient, legacyDone: emailGateDone() }) &&
    !tourComplete(seen);

  const observation: ChatObservation = {
    replyStarted: busy,
    replyFinished,
    approvalVisible: Boolean(
      bot?.messages.some((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed),
    ),
    connectorVisible: Boolean(
      bot?.messages.some((m) => m.kind === "connector" && m.connector && !m.connector.dismissed && m.connector.status !== "connected"),
    ),
  };

  useEffect(() => {
    if (!eligible) return;
    const next = nextSpotlight(observation, seen, active);
    if (next !== active) setActive(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, seen, active, observation.replyStarted, observation.replyFinished, observation.approvalVisible, observation.connectorVisible]);

  const dismiss = useCallback(() => {
    if (!active) return;
    const id = active;
    setDismissed((previous) => [...previous, id]);
    setActive(null);
    const patch = hintSeenPatch(record, id);
    if (!patch) return;
    void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  }, [active, record, dispatch]);

  if (!eligible || !active || !bot) return null;
  const copy = COPY[active];
  return (
    <Spotlight
      key={active}
      anchor={anchorFor(active)}
      placement={placementFor(active)}
      mascot={copy.mascot}
      primary={{ label: t("onboarding.spot.gotIt"), onClick: dismiss }}
      onDone={dismiss}
    >
      {t(copy.key)}
    </Spotlight>
  );
}
