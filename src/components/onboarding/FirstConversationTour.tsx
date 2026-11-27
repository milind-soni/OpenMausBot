import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hintSeenPatch, welcomeDue } from "@/lib/onboarding";
import { useAdvancedMode } from "@/lib/interface-mode";
import { emailGateDone } from "@/lib/analytics";
import { anchorFor, cardAnswered, nextSpotlight, placementFor, tourComplete, type ChatObservation, type SpotlightId } from "@/lib/first-conversation";
import { t } from "@/lib/i18n";
import type { MausState } from "@/lib/mascot";
import { api, useStore } from "@/state/store";
import { Spotlight } from "./Spotlight";

const COPY: Record<SpotlightId, { key: "onboarding.spot.composer" | "onboarding.spot.model" | "onboarding.spot.approval" | "onboarding.spot.connector"; mascot: MausState }> = {
  "spot.composer": { key: "onboarding.spot.composer", mascot: "happy" },
  "spot.model": { key: "onboarding.spot.model", mascot: "curious" },
  "spot.approval": { key: "onboarding.spot.approval", mascot: "suspicious" },
  "spot.connector": { key: "onboarding.spot.connector", mascot: "curious" },
};

/** Spotlights on the first chat, in Advanced mode only: Simple mode's cards carry a one-line hint instead. */
export function FirstConversationTour({ quiet = false }: { quiet?: boolean }) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const record = state.config?.onboarding;
  const [dismissed, setDismissed] = useState<string[]>([]);
  const seen = useMemo(() => [...(record?.hintsSeen ?? []), ...dismissed, "spot.composer", "spot.model"], [record?.hintsSeen, dismissed]);
  const [active, setActive] = useState<SpotlightId | null>(null);
  const [replyFinished, setReplyFinished] = useState(false);
  const sawBusy = useRef(false);

  const bot = state.bots.find((b) => b.id === state.selectedId) ?? null;
  const busy = Boolean(bot?.busy);

  useEffect(() => {
    if (busy) sawBusy.current = true;
    else if (sawBusy.current) setReplyFinished(true);
  }, [busy]);

  const eligible =
    advanced &&
    !quiet &&
    !remoteClient &&
    !state.welcomeOpen &&
    Boolean(record?.completedAt) &&
    !state.tourOpen &&
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

  useEffect(() => {
    if (!eligible) return;
    if (active && cardAnswered(active, observation)) {
      dismiss();
      return;
    }
    const next = nextSpotlight(observation, seen, active);
    if (next !== active) setActive(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, seen, active, dismiss, observation.replyStarted, observation.replyFinished, observation.approvalVisible, observation.connectorVisible]);

  if (!eligible || !active || !bot || cardAnswered(active, observation)) return null;
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
